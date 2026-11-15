// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OrynPool} from "../OrynPool.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

abstract contract OrynPoolTestBase is Test {
    OrynPool internal pool;
    MockERC20 internal usdc;
    MockERC20 internal eurc;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice"); // supplier
    address internal bob = makeAddr("bob"); // borrower
    address internal carol = makeAddr("carol");
    address internal liq = makeAddr("liquidator");

    uint256 internal constant PRICE = 110_220_000; // 1.1022e8
    uint256 internal constant M = 1e6;
    uint256 internal constant START = 1_700_000_000;

    function setUp() public virtual {
        vm.warp(START);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);
        pool = new OrynPool(owner, address(usdc), address(eurc), PRICE);

        address[5] memory users = [alice, bob, carol, liq, owner];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 100_000_000e6);
            eurc.mint(users[i], 100_000_000e6);
            vm.startPrank(users[i]);
            usdc.approve(address(pool), type(uint256).max);
            eurc.approve(address(pool), type(uint256).max);
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

    function _setPrice(uint256 p) internal {
        vm.prank(owner);
        pool.setEurcPrice(p);
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

    function _ceil(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return Math.mulDiv(x, y, d, Math.Rounding.Ceil);
    }
}
