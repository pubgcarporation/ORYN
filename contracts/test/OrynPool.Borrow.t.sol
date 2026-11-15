// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolBorrowTest is OrynPoolTestBase {
    // ---------------------------------------------------------------- cross-collateral borrow
    function test_Borrow_EurcAgainstUsdc_RespectsLtv80() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 800e8); // 80% of $1000

        uint256 maxB = pool.maxBorrowable(address(eurc), bob);
        // 800 / 1.1022 = 725.82 EURC
        assertGe(maxB, 725 * M);
        assertLt(maxB, 726 * M);

        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.Borrow(bob, address(eurc), 725 * M, 725 * M);
        uint256 before = eurc.balanceOf(bob);
        _borrow(bob, eurc, 725 * M);
        assertEq(eurc.balanceOf(bob), before + 725 * M);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 725 * M);

        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(eurc), 726 * M);
    }

    function test_Borrow_EurcAgainstUsdc_ExactMaxBoundary() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        uint256 maxB = pool.maxBorrowable(address(eurc), bob);
        _borrow(bob, eurc, maxB);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(eurc), 1);
    }

    function test_Borrow_UsdcAgainstEurc_RespectsLtv75() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M);
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 82_665_000_000); // 1000*1.1022*0.75 = $826.65

        uint256 maxB = pool.maxBorrowable(address(usdc), bob);
        assertGe(maxB, 826 * M);
        assertLt(maxB, 827 * M);

        uint256 before = usdc.balanceOf(bob);
        _borrow(bob, usdc, 826 * M);
        assertEq(usdc.balanceOf(bob), before + 826 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 826 * M);

        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(usdc), 827 * M);
    }

    function test_Borrow_CollateralFromBothMarketsCounts() public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        _deposit(bob, eurc, 1_000 * M);
        // 800 + 826.65 = 1626.65 USD of capacity
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 80_000_000_000 + 82_665_000_000);
        _borrow(bob, usdc, 1_600 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 1_600 * M);
    }

    function test_Borrow_Reverts() public {
        _liquidity();
        vm.startPrank(bob);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.borrow(address(eurc), 0);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.borrow(address(0x1234), 1);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector); // no collateral
        pool.borrow(address(eurc), 1 * M);
        vm.stopPrank();
    }

    function test_Borrow_RevertsWithoutCash() public {
        _deposit(alice, eurc, 100 * M);
        _deposit(bob, usdc, 10_000 * M);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.InsufficientLiquidity.selector, address(eurc), 101 * M, 100 * M));
        pool.borrow(address(eurc), 101 * M);
    }

    function test_Borrow_BorrowCap() public {
        _liquidity();
        _deposit(bob, usdc, 5_000 * M);
        _applyRisk(address(eurc), 7_500, 8_000, 500, 0, 100 * M);

        vm.prank(bob);
        vm.expectRevert(OrynPool.BorrowCapExceeded.selector);
        pool.borrow(address(eurc), 100 * M + 1);

        _borrow(bob, eurc, 100 * M); // exactly the cap
        assertEq(pool.maxBorrowable(address(eurc), bob), 0);
        vm.prank(bob);
        vm.expectRevert(OrynPool.BorrowCapExceeded.selector);
        pool.borrow(address(eurc), 1);

        // the cap is global to the market, not per user
        _deposit(carol, usdc, 5_000 * M);
        vm.prank(carol);
        vm.expectRevert(OrynPool.BorrowCapExceeded.selector);
        pool.borrow(address(eurc), 1 * M);

        // other market unaffected
        _deposit(carol, eurc, 5_000 * M);
        _borrow(carol, usdc, 1_000 * M);
    }

    // ---------------------------------------------------------------- repay
    function test_Repay_Partial() public {
        _bobPosition(500 * M);
        uint256 before = eurc.balanceOf(bob);
        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Repay(bob, bob, address(eurc), 200 * M, 200 * M);
        _repay(bob, eurc, 200 * M);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 300 * M);
        assertEq(eurc.balanceOf(bob), before - 200 * M);
    }

    function test_Repay_FullWithMax() public {
        _bobPosition(500 * M);
        uint256 before = eurc.balanceOf(bob);
        _repay(bob, eurc, type(uint256).max);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
        assertEq(pool.scaledDebtOf(address(eurc), bob), 0);
        assertEq(eurc.balanceOf(bob), before - 500 * M);
        assertEq(pool.getReserveData(address(eurc)).totalBorrowed, 0);
    }

    function test_Repay_FullWithMaxAfterInterest() public {
        _bobPosition(500 * M);
        skip(30 days);
        uint256 debt = pool.debtBalanceOf(address(eurc), bob);
        assertGt(debt, 500 * M);
        uint256 before = eurc.balanceOf(bob);
        _repay(bob, eurc, type(uint256).max);
        assertEq(before - eurc.balanceOf(bob), debt);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
    }

    function test_Repay_MoreThanDebtOnlyPullsDebt() public {
        _bobPosition(500 * M);
        uint256 before = eurc.balanceOf(bob);
        _repay(bob, eurc, 10_000 * M);
        assertEq(before - eurc.balanceOf(bob), 500 * M);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
    }

    function test_Repay_Reverts() public {
        _bobPosition(500 * M);
        vm.startPrank(bob);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.repay(address(eurc), 0);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.repay(address(0x1234), 1);
        vm.expectRevert(OrynPool.ZeroShares.selector); // no USDC debt
        pool.repay(address(usdc), 1 * M);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- interest & reserves
    /// @dev alice supplies 10,000 USDC; bob posts 20,000 EURC and borrows 8,000 USDC (80% utilization).
    function _utilization80() internal {
        _deposit(alice, usdc, 10_000 * M);
        _deposit(bob, eurc, 20_000 * M);
        _borrow(bob, usdc, 8_000 * M);
    }

    function test_Rates_At80PercentUtilization() public {
        _utilization80();
        assertEq(pool.getReserveData(address(usdc)).utilization, 0.8e18);
        assertEq(pool.borrowRate(address(usdc)), 0.04e18);
        // supply = borrow * util * (1 - 10% reserve factor) = 2.88%
        assertEq(pool.supplyRate(address(usdc)), 0.0288e18);
        assertLt(pool.supplyRate(address(usdc)), pool.borrowRate(address(usdc)));
    }

    function test_Interest_SuppliersEarnLessThanBorrowersPay() public {
        _utilization80();
        skip(365 days);

        uint256 debt = pool.debtBalanceOf(address(usdc), bob);
        uint256 supplied = pool.supplyBalanceOf(address(usdc), alice);
        uint256 borrowerInterest = debt - 8_000 * M;
        uint256 supplierInterest = supplied - 10_000 * M;

        assertApproxEqAbs(borrowerInterest, 320 * M, 2); // 4% of 8000
        assertApproxEqAbs(supplierInterest, 288 * M, 2); // 90% of that
        assertLt(supplierInterest, borrowerInterest);
        assertApproxEqRel(supplierInterest * 10_000 / borrowerInterest, 9_000, 1e15);
        // the difference is protocol reserves (10%)
        assertApproxEqAbs(pool.protocolReservesOf(address(usdc)), 32 * M, 2);
        assertEq(borrowerInterest - supplierInterest, pool.protocolReservesOf(address(usdc)));
    }

    function test_Interest_FullUnwindConservesFunds() public {
        _utilization80();
        skip(365 days);
        uint256 debt = pool.debtBalanceOf(address(usdc), bob);
        _repay(bob, usdc, type(uint256).max);
        _withdraw(alice, usdc, type(uint256).max);
        // what is left in the pool is exactly the protocol's reserve share
        assertEq(usdc.balanceOf(address(pool)), pool.protocolReservesOf(address(usdc)));
        assertApproxEqAbs(usdc.balanceOf(address(pool)), debt - 8_000 * M - 288 * M, 2);
        // bob can now exit his collateral
        _withdraw(bob, eurc, type(uint256).max);
    }

    function test_Accrue_IsPermissionlessAndEmits() public {
        _utilization80();
        skip(10 days);
        vm.expectEmit(true, false, false, false, address(pool));
        emit OrynPool.Accrued(address(usdc), 0, 0, 0, 0);
        vm.prank(carol);
        pool.accrue(address(usdc));
        assertGt(pool.scaledDebtOf(address(usdc), bob), 0);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.accrue(address(0x1234));
    }

    function test_CollectReserves_BoundsAndHappyPath() public {
        _utilization80();
        skip(365 days);

        vm.startPrank(owner);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.collectReserves(address(usdc), owner, 0);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.collectReserves(address(usdc), address(0), 1);
        vm.expectRevert(OrynPool.InvalidRecipient.selector);
        pool.collectReserves(address(usdc), address(pool), 1);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.collectReserves(address(0x1234), owner, 1);
        vm.expectRevert(OrynPool.InsufficientReserves.selector); // reserves ~32 USDC
        pool.collectReserves(address(usdc), owner, 33 * M);
        vm.stopPrank();

        uint256 reserves = pool.protocolReservesOf(address(usdc));
        vm.expectEmit(true, true, false, true, address(pool));
        emit OrynPool.ReservesCollected(address(usdc), carol, reserves);
        uint256 before = usdc.balanceOf(carol);
        vm.prank(owner);
        pool.collectReserves(address(usdc), carol, reserves);
        assertEq(usdc.balanceOf(carol), before + reserves);
        assertEq(pool.protocolReservesOf(address(usdc)), 0);

        vm.prank(owner);
        vm.expectRevert(OrynPool.InsufficientReserves.selector);
        pool.collectReserves(address(usdc), owner, 1);

        // suppliers' claims are untouched: alice can still exit fully once bob repays
        _repay(bob, usdc, type(uint256).max);
        _withdraw(alice, usdc, type(uint256).max);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_CollectReserves_CannotTouchSupplierCash() public {
        _deposit(alice, usdc, 1_000 * M);
        // no interest -> no reserves, even though the pool holds 1000 USDC cash
        vm.prank(owner);
        vm.expectRevert(OrynPool.InsufficientReserves.selector);
        pool.collectReserves(address(usdc), owner, 1);
    }

    function test_CollectReserves_DonationsBecomeReserves_NotShareValue() public {
        _deposit(alice, usdc, 1_000 * M);
        usdc.mint(address(pool), 500 * M); // unsolicited donation
        assertEq(pool.supplyBalanceOf(address(usdc), alice), 1_000 * M); // no share inflation
        assertEq(pool.protocolReservesOf(address(usdc)), 500 * M);
        vm.prank(owner);
        pool.collectReserves(address(usdc), owner, 500 * M);
        _withdraw(alice, usdc, type(uint256).max);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }
}
