// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OrynPool} from "../OrynPool.sol";
import {MirrorAggregator} from "../MirrorAggregator.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockAggregator} from "../test-helpers/MockAggregator.sol";

abstract contract OrynPoolTestBase is Test {
    OrynPool internal pool;
    MirrorAggregator internal feed; // EURC/USD
    MockAggregator internal usdcFeed; // USDC/USD, default exactly 1.00000000 (8 decimals)
    MockERC20 internal usdc;
    MockERC20 internal eurc;
    MockERC20 internal cirbtc; // 8 decimals
    MockAggregator internal btcFeed; // BTC/USD, default exactly 100000.00000000 (8 decimals)

    address internal owner = makeAddr("owner");
    address internal updater = makeAddr("updater");
    address internal alice = makeAddr("alice"); // supplier
    address internal bob = makeAddr("bob"); // borrower
    address internal carol = makeAddr("carol");
    address internal liq = makeAddr("liquidator");

    uint256 internal constant PRICE = 110_220_000; // 1.1022e8
    uint256 internal constant USDC_PRICE = 100_000_000; // 1.00000000
    uint256 internal constant BTC_PRICE = 100_000e8; // 100000.00000000
    uint256 internal constant M = 1e6;
    uint256 internal constant B = 1e8; // one cirBTC
    uint256 internal constant START = 1_700_000_000;

    uint80 internal srcRound;
    uint256 internal lastPushTs;
    uint256 internal usdcPriceNow = USDC_PRICE; // answer re-published whenever the EURC feed is pushed
    uint256 internal btcPriceNow = BTC_PRICE; // likewise for BTC

    function setUp() public virtual {
        vm.warp(START);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);
        cirbtc = new MockERC20("Circle BTC", "cirBTC", 8);
        feed = new MirrorAggregator(owner, updater, 8, "EURC / USD");
        usdcFeed = new MockAggregator(8);
        usdcFeed.setRound(int256(USDC_PRICE), START);
        btcFeed = new MockAggregator(8);
        btcFeed.setRound(int256(BTC_PRICE), START);
        pool = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(feed), address(btcFeed));
        _push(PRICE, START); // initial Chainlink round, timestamp = now

        _fund(pool);
    }

    function _fund(OrynPool p) internal {
        address[5] memory users = [alice, bob, carol, liq, owner];
        for (uint256 i; i < users.length; ++i) {
            if (usdc.balanceOf(users[i]) == 0) {
                usdc.mint(users[i], 100_000_000e6);
                eurc.mint(users[i], 100_000_000e6);
                cirbtc.mint(users[i], 1_000_000e8);
            }
            vm.startPrank(users[i]);
            usdc.approve(address(p), type(uint256).max);
            eurc.approve(address(p), type(uint256).max);
            cirbtc.approve(address(p), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _deposit(address u, MockERC20 t, uint256 a) internal {
        vm.prank(u);
        pool.deposit(address(t), a);
    }

    function _withdraw(address u, MockERC20 t, uint256 a) internal {
        vm.prank(u);
        pool.withdraw(address(t), a);
    }

    function _borrow(address u, MockERC20 t, uint256 a) internal {
        vm.prank(u);
        pool.borrow(address(t), a);
    }

    function _repay(address u, MockERC20 t, uint256 a) internal {
        vm.prank(u);
        pool.repay(address(t), a);
    }

    /// @dev Pushes an EURC Chainlink round with an explicit source timestamp (must be strictly increasing).
    ///      The USDC feed is re-published with the same source timestamp and its current answer, so the
    ///      pool's combined freshness (older of the two) behaves exactly as with a single feed.
    function _push(uint256 p, uint256 sourceTs) internal {
        vm.prank(updater);
        feed.pushRound(int256(p), sourceTs, ++srcRound);
        lastPushTs = sourceTs;
        usdcFeed.setRound(int256(usdcPriceNow), sourceTs);
        btcFeed.setRound(int256(btcPriceNow), sourceTs);
    }

    /// @dev Publishes a USDC/USD round "now" without touching the EURC feed.
    function _setUsdcPrice(uint256 p) internal {
        usdcPriceNow = p;
        usdcFeed.setRound(int256(p), block.timestamp);
    }

    /// @dev Publishes a BTC/USD round "now" without touching the other feeds.
    function _setBtcPrice(uint256 p) internal {
        btcPriceNow = p;
        btcFeed.setRound(int256(p), block.timestamp);
    }

    /// @dev Pushes a fresh round stamped "now"; advances 1s first if "now" was already used.
    function _setPrice(uint256 p) internal {
        if (block.timestamp <= lastPushTs) skip(lastPushTs + 1 - block.timestamp);
        _push(p, block.timestamp);
    }

    /// @dev Queue risk params, wait out the 6h delay, then apply them.
    function _applyRisk(address asset, uint256 ltv, uint256 lt, uint256 bonus, uint256 supplyCap, uint256 borrowCap)
        internal
    {
        vm.prank(owner);
        pool.setRiskParams(asset, ltv, lt, bonus, supplyCap, borrowCap);
        skip(6 hours);
        vm.prank(owner);
        pool.applyPendingRiskParams(asset);
    }

    /// @dev alice supplies 10,000 of each asset.
    function _liquidity() internal {
        _deposit(alice, usdc, 10_000 * M);
        _deposit(alice, eurc, 10_000 * M);
    }

    /// @dev bob supplies 1,000 USDC and borrows `borrowEurc` EURC.
    function _bobPosition(uint256 borrowEurc) internal {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        _borrow(bob, eurc, borrowEurc);
    }

    /// @dev alice supplies 10,000 USDC, 10,000 EURC and 100 cirBTC.
    function _liquidity3() internal {
        _liquidity();
        _deposit(alice, cirbtc, 100 * B);
    }

    /// @dev Single floor-rounded seizure: floor(applied * pd * unitC * (BPS + bonus) / (pc * unitD * BPS)).
    function _seizeFloor(uint256 applied, uint256 pd, uint256 pc, uint256 unitD, uint256 unitC, uint256 bonus)
        internal pure returns (uint256)
    {
        return Math.mulDiv(applied * pd * unitC, 10_000 + bonus, pc * unitD * 10_000);
    }

    function _ceil(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return Math.mulDiv(x, y, d, Math.Rounding.Ceil);
    }
}
