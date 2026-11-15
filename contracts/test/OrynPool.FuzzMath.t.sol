// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolFuzzMathTest is OrynPoolTestBase {
    /// @dev Moves the oracle to `target` with a single Chainlink round.
    function _walkPrice(uint256 target) internal {
        skip(1 hours);
        _setPrice(target);
        assertEq(pool.eurUsdPrice(), target);
    }

    function testFuzz_InterestAccrualIsMonotonic(uint256 borrowed, uint256 dt1, uint256 dt2) public {
        _liquidity();
        _deposit(bob, usdc, 100_000 * M);
        borrowed = bound(borrowed, 1 * M, 8_000 * M);
        _borrow(bob, eurc, borrowed);
        dt1 = bound(dt1, 1, 180 days);
        dt2 = bound(dt2, 1, 180 days);

        address e = address(eurc);
        skip(dt1);
        uint256 debt1 = pool.debtBalanceOf(e, bob);
        uint256 supply1 = pool.supplyBalanceOf(e, alice);
        uint256 res1 = pool.protocolReservesOf(e);
        uint256 tb1 = pool.getReserveData(e).totalBorrowed;
        assertGe(debt1, borrowed, "debt1");
        assertGe(supply1, 10_000 * M, "supply1");

        skip(dt2);
        assertGe(pool.debtBalanceOf(e, bob), debt1, "debt2");
        assertGe(pool.supplyBalanceOf(e, alice), supply1, "supply2");
        // reserves are derived from ceil(debt) - floor(supplied): may lose 1 wei of rounding dust per accrual
        assertGe(pool.protocolReservesOf(e) + 1, res1, "res2");
        assertGe(pool.getReserveData(e).totalBorrowed, tb1, "tb2");

        // materialising interest on-chain must match the preview and never reduce balances
        uint256 previewDebt = pool.debtBalanceOf(e, bob);
        pool.accrue(e);
        assertEq(pool.debtBalanceOf(e, bob), previewDebt);
    }

    function testFuzz_HealthFactorSign_MatchesLiquidatability(uint256 borrowed, uint256 targetPrice) public {
        _liquidity();
        _deposit(bob, usdc, 1_000 * M);
        // bob may borrow up to 80% * 1000 USD at 1.1022 => ~725 EURC; stay safely inside
        borrowed = bound(borrowed, 10 * M, 700 * M);
        _borrow(bob, eurc, borrowed);
        targetPrice = bound(targetPrice, 50_000_000, 200_000_000);
        _walkPrice(targetPrice);

        OrynPool.AccountData memory d = pool.getAccountData(bob);
        assertGt(d.borrowValueUsd, 0);
        bool healthy = d.healthFactorWad >= 1e18;
        // PROPERTY: HF >= 1 exactly when debt <= liquidation limit
        assertEq(healthy, d.borrowValueUsd <= d.liquidationLimitUsd);

        if (healthy) {
            vm.expectRevert(OrynPool.NotLiquidatable.selector);
            vm.prank(liq);
            pool.liquidate(bob, address(eurc), address(usdc), 1 * M);
        } else {
            uint256 debtBefore = pool.debtBalanceOf(address(eurc), bob);
            vm.prank(liq);
            pool.liquidate(bob, address(eurc), address(usdc), 1 * M);
            assertLt(pool.debtBalanceOf(address(eurc), bob), debtBefore);
        }
    }

    function testFuzz_HealthFactorIsMaxWithoutDebt(uint256 amount) public {
        amount = bound(amount, 1, 1e12);
        _deposit(bob, usdc, amount);
        assertEq(pool.getAccountData(bob).healthFactorWad, type(uint256).max);
        (,,,, uint256 hf) = pool.getUserAccount(bob);
        assertEq(hf, type(uint256).max);
    }

    function testFuzz_BorrowWithinLimitKeepsHealthAboveOne(uint256 deposit, uint256 frac) public {
        _liquidity();
        deposit = bound(deposit, 100 * M, 1_000_000 * M);
        _deposit(bob, usdc, deposit);
        uint256 max = pool.maxBorrowable(address(eurc), bob);
        max = max > 9_000 * M ? 9_000 * M : max;
        frac = bound(frac, 1, 100);
        uint256 amt = max * frac / 100;
        vm.assume(amt > 0);
        _borrow(bob, eurc, amt);
        assertGe(pool.getAccountData(bob).healthFactorWad, 1e18);
        (, bool ok) = pool.previewBorrowLimit(bob, address(eurc), 0);
        assertTrue(ok);
    }
}
