// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OrynPool} from "../OrynPool.sol";
import {MirrorAggregator} from "../MirrorAggregator.sol";
import {MockAggregator} from "../test-helpers/MockAggregator.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev Drives bounded pool actions from three actors; failing calls are swallowed.
contract OrynPoolHandler is Test {
    OrynPool public pool;
    MockERC20 public usdc;
    MockERC20 public eurc;
    MirrorAggregator public feed;
    MockAggregator public usdcFeed;
    address public updater;
    uint80 public srcRound = 1_000;
    address[3] public actors;

    constructor(OrynPool pool_, MockERC20 usdc_, MockERC20 eurc_, MirrorAggregator feed_, MockAggregator usdcFeed_,
        address updater_) {
        pool = pool_;
        usdc = usdc_;
        eurc = eurc_;
        feed = feed_;
        usdcFeed = usdcFeed_;
        updater = updater_;
        for (uint256 i; i < 3; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors[i] = a;
            usdc.mint(a, 1e15);
            eurc.mint(a, 1e15);
            vm.startPrank(a);
            usdc.approve(address(pool), type(uint256).max);
            eurc.approve(address(pool), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _a(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _t(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? address(usdc) : address(eurc);
    }

    function deposit(uint256 who, uint256 asset, uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        address t = _t(asset);
        vm.prank(_a(who));
        try pool.deposit(t, amount) {} catch {}
    }

    function withdraw(uint256 who, uint256 asset, uint256 amount, bool all) external {
        amount = all ? type(uint256).max : bound(amount, 1, 1e12);
        address t = _t(asset);
        vm.prank(_a(who));
        try pool.withdraw(t, amount) {} catch {}
    }

    function borrow(uint256 who, uint256 asset, uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        address t = _t(asset);
        vm.prank(_a(who));
        try pool.borrow(t, amount) {} catch {}
    }

    function repay(uint256 who, uint256 asset, uint256 amount, bool all) external {
        amount = all ? type(uint256).max : bound(amount, 1, 1e12);
        address t = _t(asset);
        vm.prank(_a(who));
        try pool.repay(t, amount) {} catch {}
    }

    function liquidate(uint256 who, uint256 victim, uint256 asset, uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        address debtAsset = _t(asset);
        address colAsset = _t(asset + 1);
        address v = _a(victim);
        vm.prank(_a(who));
        try pool.liquidate(v, debtAsset, colAsset, amount) {} catch {}
    }

    /// @dev Advances time and relays a fresh Chainlink round so risk-increasing paths stay reachable.
    function warp(uint256 secs) external {
        secs = bound(secs, 1, 30 days);
        vm.warp(block.timestamp + secs);
        _push(pool.eurUsdPrice());
        usdcFeed.setRound(int256(pool.usdcUsdPrice()), block.timestamp);
    }

    /// @dev USDC depegs/repegs within 0.85..1.05 so liquidations driven by USDC price are explored.
    function moveUsdcPrice(uint256 pct) external {
        pct = bound(pct, 85, 105);
        usdcFeed.setRound(int256(1e8 * pct / 100), block.timestamp);
    }

    function movePrice(uint256 pct) external {
        pct = bound(pct, 50, 150);
        uint256 p = pool.eurUsdPrice() * pct / 100;
        if (p < 60_000_000) p = 60_000_000;
        if (p > 190_000_000) p = 190_000_000;
        _push(p);
    }

    function _push(uint256 p) internal {
        vm.prank(updater);
        try feed.pushRound(int256(p), block.timestamp, ++srcRound) {} catch {}
    }

    function donate(uint256 asset, uint256 amount) external {
        amount = bound(amount, 1, 1e9);
        MockERC20(_t(asset)).mint(address(pool), amount);
    }
}

contract OrynPoolInvariantTest is OrynPoolTestBase {
    OrynPoolHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new OrynPoolHandler(pool, usdc, eurc, feed, usdcFeed, updater);
        targetContract(address(handler));
    }

    function _check(MockERC20 t) internal view {
        OrynPool.ReserveData memory d = pool.getReserveData(address(t)); // reverts on AccountingDeficit
        // CORE: cash + totalBorrowed >= totalSupplied
        assertGe(t.balanceOf(address(pool)) + d.totalBorrowed, d.totalSupplied);
        // reserves are exactly the surplus
        assertEq(
            pool.protocolReservesOf(address(t)), t.balanceOf(address(pool)) + d.totalBorrowed - d.totalSupplied
        );
        // individual supplier balances (rounded down) never exceed the aggregate
        uint256 sumSupply;
        uint256 sumDebt;
        for (uint256 i; i < 3; ++i) {
            address a = handler.actors(i);
            sumSupply += pool.supplyBalanceOf(address(t), a);
            sumDebt += pool.debtBalanceOf(address(t), a);
        }
        assertLe(sumSupply, d.totalSupplied);
        // individual debts (rounded up) cover the aggregate
        assertGe(sumDebt, d.totalBorrowed);
        assertLe(d.totalBorrowed, sumDebt);
    }

    function invariant_CashPlusBorrowedCoversSupplied_USDC() public view {
        _check(usdc);
    }

    function invariant_CashPlusBorrowedCoversSupplied_EURC() public view {
        _check(eurc);
    }
}
