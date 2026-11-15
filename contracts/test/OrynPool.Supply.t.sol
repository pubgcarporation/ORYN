// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolSupplyTest is OrynPoolTestBase {
    // ---------------------------------------------------------------- deposit
    function test_Deposit_HappyPath() public {
        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Deposit(alice, address(usdc), 1_000 * M, 1_000 * M);
        _deposit(alice, usdc, 1_000 * M);

        assertEq(pool.supplyBalanceOf(address(usdc), alice), 1_000 * M);
        assertEq(pool.scaledSupplyOf(address(usdc), alice), 1_000 * M);
        assertEq(usdc.balanceOf(address(pool)), 1_000 * M);
        assertEq(usdc.balanceOf(alice), before - 1_000 * M);
        assertEq(pool.getReserveData(address(usdc)).totalSupplied, 1_000 * M);
        assertEq(pool.supplyBalanceOf(address(eurc), alice), 0);
    }

    function test_Deposit_EurcMarketIsIndependent() public {
        _deposit(alice, eurc, 500 * M);
        assertEq(pool.supplyBalanceOf(address(eurc), alice), 500 * M);
        assertEq(pool.getReserveData(address(usdc)).totalSupplied, 0);
        assertEq(pool.getReserveData(address(eurc)).totalSupplied, 500 * M);
    }

    function test_Deposit_Reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.deposit(address(usdc), 0);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.deposit(address(0x1234), 1);
        usdc.approve(address(pool), 0);
        vm.expectRevert(); // ERC20InsufficientAllowance
        pool.deposit(address(usdc), 1 * M);
        vm.stopPrank();

        address dave = makeAddr("dave"); // no balance
        vm.startPrank(dave);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(); // ERC20InsufficientBalance
        pool.deposit(address(usdc), 1 * M);
        vm.stopPrank();
    }

    function test_Deposit_SupplyCap() public {
        _applyRisk(address(usdc), 8_000, 8_500, 500, 1_000 * M, 0);
        _deposit(alice, usdc, 600 * M);
        _deposit(bob, usdc, 400 * M); // exactly at the cap
        vm.prank(carol);
        vm.expectRevert(OrynPool.SupplyCapExceeded.selector);
        pool.deposit(address(usdc), 1);

        // the cap is per market: EURC unaffected
        _deposit(carol, eurc, 5_000 * M);

        // queued cap does not apply until the delay elapses and the owner applies it
        vm.prank(owner);
        pool.setRiskParams(address(usdc), 8_000, 8_500, 500, 2_000 * M, 0);
        vm.prank(carol);
        vm.expectRevert(OrynPool.SupplyCapExceeded.selector);
        pool.deposit(address(usdc), 1);
        skip(6 hours);
        vm.prank(owner);
        pool.applyPendingRiskParams(address(usdc));
        _deposit(carol, usdc, 1_000 * M);
        assertEq(pool.getReserveData(address(usdc)).totalSupplied, 2_000 * M);
    }

    // ---------------------------------------------------------------- withdraw
    function test_Withdraw_PartialThenMax() public {
        _deposit(alice, usdc, 1_000 * M);
        uint256 before = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Withdraw(alice, address(usdc), 300 * M, 300 * M);
        _withdraw(alice, usdc, 300 * M);
        assertEq(pool.supplyBalanceOf(address(usdc), alice), 700 * M);
        assertEq(usdc.balanceOf(alice), before + 300 * M);

        _withdraw(alice, usdc, type(uint256).max);
        assertEq(pool.supplyBalanceOf(address(usdc), alice), 0);
        assertEq(pool.scaledSupplyOf(address(usdc), alice), 0);
        assertEq(usdc.balanceOf(alice), before + 1_000 * M);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_Withdraw_Reverts() public {
        _deposit(alice, usdc, 1_000 * M);
        vm.startPrank(alice);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.withdraw(address(usdc), 0);
        vm.expectRevert(OrynPool.InsufficientSupply.selector);
        pool.withdraw(address(usdc), 1_000 * M + 1);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.withdraw(address(0x1234), 1);
        vm.stopPrank();

        vm.prank(bob); // never deposited
        vm.expectRevert(OrynPool.InsufficientSupply.selector);
        pool.withdraw(address(usdc), 1);
        vm.prank(bob); // MAX of an empty balance -> amount 0
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.withdraw(address(usdc), type(uint256).max);
    }

    function test_Withdraw_RevertsWhenCashLentOut() public {
        _deposit(alice, usdc, 1_000 * M);
        _deposit(bob, eurc, 5_000 * M);
        _borrow(bob, usdc, 900 * M);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.InsufficientLiquidity.selector, address(usdc), 1_000 * M, 100 * M));
        pool.withdraw(address(usdc), 1_000 * M);
        _withdraw(alice, usdc, 100 * M); // what is left is withdrawable
    }

    function test_Withdraw_WithDebt_RespectsLtv() public {
        _bobPosition(400 * M); // 400 EURC = 440.88 USD vs capacity 800 USD
        _withdraw(bob, usdc, 400 * M); // remaining 600 * 0.8 = 480 >= 440.88
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 600 * M);
        vm.prank(bob); // 500 * 0.8 = 400 < 440.88
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(usdc), 100 * M);
    }

    function test_Withdraw_MaxWithdrawableIsExactBoundary() public {
        _bobPosition(400 * M);
        uint256 maxW = pool.maxWithdrawable(address(usdc), bob);
        assertGt(maxW, 400 * M);
        assertLt(maxW, 1_000 * M);
        _withdraw(bob, usdc, maxW);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(usdc), 1);
    }

    function test_Withdraw_DebtFreeCollateralAfterFullRepay() public {
        _bobPosition(400 * M);
        _repay(bob, eurc, type(uint256).max);
        _withdraw(bob, usdc, type(uint256).max);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 0);
    }
}
