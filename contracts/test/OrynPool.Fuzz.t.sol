// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "../test-helpers/MockERC20.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolFuzzTest is OrynPoolTestBase {
    function _tok(bool useEurc) internal view returns (MockERC20) {
        return useEurc ? eurc : usdc;
    }

    function testFuzz_DepositWithdrawRoundTrip_NeverReturnsMore(uint256 amount, bool useEurc) public {
        MockERC20 t = _tok(useEurc);
        amount = bound(amount, 1, 1e14);
        uint256 before = t.balanceOf(alice);
        _deposit(alice, t, amount);
        _withdraw(alice, t, type(uint256).max);
        assertLe(t.balanceOf(alice), before);
        assertEq(t.balanceOf(alice), before); // with no interest the trip is lossless
        assertEq(pool.supplyBalanceOf(address(t), alice), 0);
    }

    function testFuzz_RoundTripWithDonationNeverProfits(uint256 amount, uint256 donation, bool useEurc) public {
        MockERC20 t = _tok(useEurc);
        amount = bound(amount, 1, 1e14);
        donation = bound(donation, 0, 1e14);
        t.mint(address(pool), donation); // donate before the first deposit
        uint256 before = t.balanceOf(alice);
        _deposit(alice, t, amount);
        assertLe(pool.supplyBalanceOf(address(t), alice), amount);
        _withdraw(alice, t, type(uint256).max);
        assertLe(t.balanceOf(alice), before);
    }

    function testFuzz_PartialWithdrawalsNeverExceedDeposit(uint256 amount, uint256 w1, uint256 w2) public {
        amount = bound(amount, 2, 1e14);
        w1 = bound(w1, 1, amount - 1);
        uint256 before = usdc.balanceOf(alice);
        _deposit(bob, usdc, 777 * M); // other supplier present
        _deposit(alice, usdc, amount);
        _withdraw(alice, usdc, w1);
        uint256 left = pool.supplyBalanceOf(address(usdc), alice);
        w2 = bound(w2, 1, left);
        _withdraw(alice, usdc, w2);
        assertLe(before - usdc.balanceOf(alice), amount);
        if (pool.supplyBalanceOf(address(usdc), alice) != 0) _withdraw(alice, usdc, type(uint256).max);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 777 * M); // others unaffected
    }

    function testFuzz_BorrowerNeverRepaysLessThanBorrowed(uint256 amount, bool borrowEurc) public {
        _liquidity();
        _deposit(bob, usdc, 1_000_000 * M);
        _deposit(bob, eurc, 1_000_000 * M);
        amount = bound(amount, 1, 9_000 * M);
        MockERC20 t = _tok(borrowEurc);
        uint256 before = t.balanceOf(bob);
        _borrow(bob, t, amount);
        _repay(bob, t, type(uint256).max);
        assertGe(before - t.balanceOf(bob), 0);
        assertLe(t.balanceOf(bob), before); // never profits
        assertEq(pool.debtBalanceOf(address(t), bob), 0);
    }

    function testFuzz_SupplierGainNeverExceedsBorrowerInterest(uint256 deposit, uint256 borrowed, uint256 dt) public {
        deposit = bound(deposit, 10 * M, 1e12);
        borrowed = bound(borrowed, 1 * M, deposit);
        dt = bound(dt, 1, 365 days);
        _deposit(alice, usdc, deposit);
        _deposit(bob, eurc, 1e13);
        _borrow(bob, usdc, borrowed);
        skip(dt);

        uint256 bobBefore = usdc.balanceOf(bob);
        _repay(bob, usdc, type(uint256).max);
        uint256 paid = bobBefore - usdc.balanceOf(bob);
        assertGe(paid, borrowed);

        uint256 aliceBefore = usdc.balanceOf(alice);
        _withdraw(alice, usdc, type(uint256).max);
        uint256 got = usdc.balanceOf(alice) - aliceBefore;
        assertGe(got, deposit - 1); // supplier never loses principal beyond rounding dust
        assertLe(got - deposit, paid - borrowed); // supplier interest <= borrower interest
        // the remainder is the protocol's
        assertEq(usdc.balanceOf(address(pool)), pool.protocolReservesOf(address(usdc)));
    }
}
