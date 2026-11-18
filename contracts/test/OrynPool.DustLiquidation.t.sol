// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OrynPool} from "../OrynPool.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev Single floor-rounded liquidation seizure:
///      seized = floor(applied * priceDebt * unitColl * (BPS + bonus) / (priceColl * unitDebt * BPS)).
///      All scenarios are built at ONE timestamp after risk params are applied, so both indexes stay at
///      exactly 1e18 and `applied == requested` (no share-rounding noise); the position becomes
///      liquidatable through oracle moves only (MockAggregator answers can change within a block).
contract OrynPoolDustLiquidationTest is OrynPoolTestBase {
    uint256 internal constant BPS_ = 10_000;
    uint256 internal constant USDC_UP = 123_456_789; // USDC/USD = 1.23456789
    uint256 internal constant BTC_ODD = 12_345_678_901_234; // BTC/USD = 123,456.78901234

    bool internal sShort; // collateral market has zero cash -> supply-share payout path

    // ================================================================ helpers
    function _u(address t) internal view returns (uint256) {
        return t == address(cirbtc) ? 1e8 : 1e6;
    }

    function _fwd(address d, address c, uint256 applied) internal view returns (uint256) {
        return _seizeFloor(applied, pool.priceOf(d), pool.priceOf(c), _u(d), _u(c),
            pool.getReserveData(c).liquidationBonus);
    }

    /// @dev Exact USD-value bound: seized*pc/uc <= applied*pd/ud * (1 + bonus), cross-multiplied.
    function _assertValueBound(address d, address c, uint256 applied, uint256 seized) internal view {
        uint256 bonus = pool.getReserveData(c).liquidationBonus;
        assertLe(seized * pool.priceOf(c) * _u(d) * BPS_, applied * pool.priceOf(d) * _u(c) * (BPS_ + bonus));
    }

    function _last() internal returns (uint256 repaid, uint256 seized, bool paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == OrynPool.Liquidation.selector) {
                (, repaid, seized, paid) = abi.decode(logs[i].data, (address, uint256, uint256, bool));
                return (repaid, seized, paid);
            }
        }
        revert("no Liquidation event");
    }

    function _liquidate(address d, address c, uint256 req) internal returns (uint256, uint256, bool) {
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, d, c, req);
        return _last();
    }

    function _assertSolventAll() internal view {
        MockERC20[3] memory ts = [usdc, eurc, cirbtc];
        for (uint256 i; i < 3; ++i) {
            OrynPool.ReserveData memory r = pool.getReserveData(address(ts[i]));
            assertGe(ts[i].balanceOf(address(pool)) + r.totalBorrowed, r.totalSupplied);
        }
    }

    /// @dev Builds bob's liquidatable position. btcColl: cirBTC collateral / USDC-or-EURC debt; otherwise
    ///      USDC-or-EURC collateral / cirBTC debt. `short` drains the collateral market's cash to zero.
    ///      Risk params (bonus) are applied first, while no debt exists, so no interest ever accrues.
    function _build(bool btcColl, bool altEurc, uint256 amt, uint256 bonus, bool short, uint256 pBtc, uint256 pUsdc)
        internal returns (address d, address c)
    {
        sShort = short;
        MockERC20 alt = altEurc ? eurc : usdc;
        if (btcColl) {
            (d, c) = (address(alt), address(cirbtc));
            _applyRisk(c, 7_000, 7_500, bonus, 0, 0);
            _deposit(alice, alt, 50_000_000 * M);
            _deposit(alice, cirbtc, short ? 1 * B : 100 * B);
            _deposit(bob, cirbtc, amt);
            _borrow(bob, alt, pool.maxBorrowable(d, bob));
            if (short) {
                _deposit(carol, usdc, 10_000_000 * M);
                _borrow(carol, cirbtc, cirbtc.balanceOf(address(pool)));
            }
        } else {
            (d, c) = (address(cirbtc), address(alt));
            _applyRisk(c, altEurc ? 7_500 : 8_000, altEurc ? 8_000 : 8_500, bonus, 0, 0);
            _deposit(alice, cirbtc, 100 * B);
            _deposit(alice, alt, short ? 1_000_000 * M : 50_000_000 * M);
            _deposit(bob, alt, amt);
            _borrow(bob, cirbtc, pool.maxBorrowable(d, bob));
            if (short) {
                _deposit(carol, cirbtc, 100 * B);
                _borrow(carol, alt, alt.balanceOf(address(pool)));
            }
        }
        _setBtcPrice(pBtc);
        if (!altEurc) _setUsdcPrice(pUsdc);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        assertEq(IERC(c).balanceOf(address(pool)) == 0, short);
    }

    /// @dev Fuzz-domain builder: every generated position is liquidatable by construction.
    function _fuzzBuild(uint8 flags, uint256 amt, uint256 bonus, uint256 pBtc, uint256 pOther)
        internal returns (address d, address c)
    {
        bool btcColl = flags & 1 != 0;
        bonus = bound(bonus, 0, 1_000);
        if (btcColl) {
            (amt, pBtc, pOther) = (bound(amt, 1e5, 5e9), bound(pBtc, 5_000e8, 93_000e8), bound(pOther, 1e8, 3e8));
        } else {
            (amt, pBtc, pOther) =
                (bound(amt, 100 * M, 1_000_000 * M), bound(pBtc, 110_000e8, 50_000_000e8), bound(pOther, 5e7, 1e8));
        }
        return _build(btcColl, flags & 2 != 0, amt, bonus, flags & 4 != 0, pBtc, pOther);
    }

    // ================================================================ (1) dust repayments at BTC = 100,000
    function test_Dust_1_2_10_MicroUsdc_RevertZeroSeizure() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, BTC_PRICE, USDC_UP);
        assertEq(pool.btcUsdPrice(), 100_000e8);
        uint256[3] memory dust = [uint256(1), 2, 10];
        uint256 debt = pool.debtBalanceOf(d, bob);
        uint256 col = pool.supplyBalanceOf(c, bob);
        for (uint256 i; i < 3; ++i) {
            // 10 micro-USDC = 1.2e-5 USD = 1.2e-10 BTC = 0.012 sat -> floors to zero
            assertEq(_fwd(d, c, dust[i]), 0);
            vm.prank(liq);
            vm.expectRevert(OrynPool.ZeroSeizure.selector);
            pool.liquidate(bob, d, c, dust[i]);
        }
        assertEq(pool.debtBalanceOf(d, bob), debt); // the revert rolled the repayment back
        assertEq(pool.supplyBalanceOf(c, bob), col);
    }

    function test_Dust_SweepMatchesFormulaAndValueBound() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, BTC_PRICE, USDC_UP);
        // smallest repay with a non-zero floor seizure = ceil(D / N)
        uint256 n = USDC_UP * 1e8 * 10_800;
        uint256 den = BTC_PRICE * 1e6 * BPS_;
        uint256 xStar = Math.ceilDiv(den, n);
        assertEq(xStar, 751);
        assertEq(_fwd(d, c, xStar - 1), 0);
        assertEq(_fwd(d, c, xStar), 1);
        uint256[10] memory amts = [uint256(1), 2, 10, 100, 500, xStar - 1, xStar, 1_000, 5_000, 100_000];
        for (uint256 i; i < amts.length; ++i) {
            uint256 expected = _fwd(d, c, amts[i]);
            if (expected == 0) {
                vm.prank(liq);
                vm.expectRevert(OrynPool.ZeroSeizure.selector);
                pool.liquidate(bob, d, c, amts[i]);
                continue;
            }
            (uint256 repaid, uint256 seized, bool paid) = _liquidate(d, c, amts[i]);
            assertEq(repaid, amts[i]);
            assertEq(seized, expected);
            assertTrue(paid);
            _assertValueBound(d, c, repaid, seized);
            // repaid USD = repaid*1.23456789 e-6; seized USD = seized * 1e-8 * 1e5 -> at most 1.08x + 1 sat
            uint256 repaidUsd8 = repaid * USDC_UP / 1e6;
            uint256 seizedUsd8 = seized * BTC_PRICE / 1e8;
            assertLe(seizedUsd8, repaidUsd8 * 108 / 100 + BTC_PRICE / 1e8);
        }
        _assertSolventAll();
    }

    // ================================================================ (2) 100 dust liquidations vs one shot
    function _loopVsOneShot(address d, address c, uint256 dust, bool expectPaid) internal {
        uint256 snap = vm.snapshotState();
        uint256 sumRepaid;
        uint256 sumSeized;
        uint256 liqColBefore = MockERC20(c).balanceOf(liq);
        for (uint256 i; i < 100; ++i) {
            (uint256 r, uint256 s, bool paid) = _liquidate(d, c, dust);
            assertEq(r, dust);
            assertEq(s, _fwd(d, c, dust));
            assertEq(paid, expectPaid);
            sumRepaid += r;
            sumSeized += s;
        }
        assertGt(sumSeized, 0);
        uint256 colAfterLoop = pool.supplyBalanceOf(c, bob);
        // liquidator is never paid more than the sum of `seized`
        if (expectPaid) assertEq(MockERC20(c).balanceOf(liq) - liqColBefore, sumSeized);
        else assertLe(pool.supplyBalanceOf(c, liq), sumSeized);
        _assertSolventAll();

        vm.revertToState(snap);
        (uint256 rOne, uint256 sOne,) = _liquidate(d, c, sumRepaid);
        assertEq(rOne, sumRepaid);
        assertEq(sOne, _fwd(d, c, sumRepaid));
        assertLe(sumSeized, sOne, "dust loop out-seized the one-shot liquidation");
        assertGe(colAfterLoop, pool.supplyBalanceOf(c, bob)); // borrower keeps at least as much collateral
    }

    function test_Loop100_UsdcDebtCirBtcCollateral_UnderlyingPath() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, BTC_PRICE, USDC_UP);
        _loopVsOneShot(d, c, 1_000, true); // 1000 micro-USDC -> 1.33 sat -> 1 sat each; one shot -> 133
    }

    function test_Loop100_UsdcDebtCirBtcCollateral_SharePath() public {
        (address d, address c) = _build(true, false, 1 * B, 800, true, BTC_PRICE, USDC_UP);
        _loopVsOneShot(d, c, 1_000, false);
    }

    function test_Loop100_CirBtcDebtUsdcCollateral_UnderlyingPath() public {
        (address d, address c) = _build(false, false, 100_000 * M, 500, false, BTC_ODD, 1e8);
        _loopVsOneShot(d, c, 1, true); // 1 sat -> 1296.29 micro-USDC -> 1296 each; one shot (100 sat) -> 129,629
    }

    function test_Loop100_CirBtcDebtUsdcCollateral_SharePath() public {
        (address d, address c) = _build(false, false, 100_000 * M, 500, true, BTC_ODD, 1e8);
        _loopVsOneShot(d, c, 1, false);
    }

    function test_Loop100_CirBtcDebtUsdcCollateral_PinnedValues() public {
        (address d, address c) = _build(false, false, 100_000 * M, 500, false, BTC_ODD, 1e8);
        (, uint256 s,) = _liquidate(d, c, 1);
        assertEq(s, 1_296);
        assertEq(_fwd(d, c, 100), 129_629); // one-shot beats 100 * 1296 = 129,600 + dust
    }

    // ================================================================ (3) forward / inverse consistency
    function _checkInverse(address d, address c) internal returns (uint256 m) {
        uint256 colBefore = pool.supplyBalanceOf(c, bob);
        // dynamic close factor: 50%, or 100% when health < 0.95
        uint256 closeLimit = Math.mulDiv(pool.debtBalanceOf(d, bob), pool.liquidationCloseFactor(bob), BPS_);
        uint256 snap = vm.snapshotState();
        uint256 s;
        (m, s,) = _liquidate(d, c, type(uint256).max); // applied == quote.maximumRepay (index is 1e18)
        assertGt(m, 0);
        assertEq(s, _fwd(d, c, m));
        assertLe(s, colBefore, "maximumRepay seizes more than the borrower owns");
        assertLe(m, closeLimit, "maximumRepay exceeds the close factor");
        if (m < closeLimit) assertGt(_fwd(d, c, m + 1), colBefore, "maximumRepay is not the largest repay");
        // requesting one more must be clamped to exactly the same quote
        vm.revertToState(snap);
        (uint256 m2, uint256 s2,) = _liquidate(d, c, m + 1);
        assertEq(m2, m);
        assertEq(s2, s);
    }

    function testFuzz_ForwardInverseConsistency(uint8 flags, uint256 amt, uint256 bonus, uint256 pBtc, uint256 pOther)
        public
    {
        (address d, address c) = _fuzzBuild(flags, amt, bonus, pBtc, pOther);
        _checkInverse(d, c);
    }

    /// @dev Collateral 8 sats at $30,000: seized(x) = floor(x * 0.0036); (8 + 1) / 0.0036 = 2500 exactly,
    ///      so the strict inverse bound lands on an exact integer boundary (the `tail % numerator == 0` step).
    function test_Inverse_ExactDivisibleBoundary() public {
        (address d, address c) = _build(true, false, 8, 800, false, 30_000e8, 1e8);
        assertEq(pool.debtBalanceOf(d, bob), 5_600);
        assertEq(_fwd(d, c, 2_499), 8);
        assertEq(_fwd(d, c, 2_500), 9);
        assertEq(_checkInverse(d, c), 2_499);
    }

    function test_Inverse_CollateralBinds_Then_CloseFactorBinds() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, 30_000e8, 1e8);
        assertEq(_checkInverse(d, c), 27_777_778_055); // collateral-limited (< 35,000 USDC close limit)
    }

    function test_Inverse_CloseFactorBinds() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, 90_000e8, 1e8);
        assertEq(_checkInverse(d, c), 35_000 * M); // 50% of 70,000 USDC
    }

    // ================================================================ (4) fuzz: value bound + solvency
    function testFuzz_SeizedValueBoundedAndPoolSolvent(
        uint8 flags, uint256 amt, uint256 bonus, uint256 pBtc, uint256 pOther, uint256 req
    ) public {
        (address d, address c) = _fuzzBuild(flags, amt, bonus, pBtc, pOther);
        // dynamic close factor: 50%, or 100% when health < 0.95
        uint256 closeLimit = Math.mulDiv(pool.debtBalanceOf(d, bob), pool.liquidationCloseFactor(bob), BPS_);
        // half the runs are dust-sized requests
        req = (req & 1) == 0 ? bound(req, 1, Math.min(5_000, closeLimit)) : bound(req, 1, closeLimit);
        uint256 colBefore = pool.supplyBalanceOf(c, bob);
        uint256 liqColBal = MockERC20(c).balanceOf(liq);

        vm.recordLogs();
        vm.prank(liq);
        (bool ok, bytes memory ret) = address(pool).call(abi.encodeWithSelector(bytes4(keccak256("liquidate(address,address,address,uint256)")), bob, d, c, req));
        if (!ok) {
            // the only acceptable failure is ZeroSeizure, and only when the floor formula really gives zero
            assertEq(bytes4(ret), OrynPool.ZeroSeizure.selector);
            assertEq(_fwd(d, c, req), 0);
            return;
        }
        (uint256 applied, uint256 seized, bool paid) = _last();
        assertGt(seized, 0);
        assertLe(applied, req);
        assertLe(applied, closeLimit);
        assertEq(seized, _fwd(d, c, applied));
        _assertValueBound(d, c, applied, seized); // seized USD <= repaid USD * (1 + bonus)
        assertLe(seized, colBefore);
        assertEq(pool.supplyBalanceOf(c, bob), colBefore - seized);
        assertEq(paid, !sShort);
        if (paid) assertEq(MockERC20(c).balanceOf(liq) - liqColBal, seized);
        else assertLe(pool.supplyBalanceOf(c, liq), seized);
        _assertSolventAll();
    }

    // ================================================================ (5) ZeroSeizure revert path
    function test_ZeroSeizure_RevertsAtomically_UnderlyingPath() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, BTC_PRICE, USDC_UP);
        _assertZeroSeizureAtomic(d, c);
    }

    function test_ZeroSeizure_RevertsAtomically_SharePath() public {
        (address d, address c) = _build(true, false, 1 * B, 800, true, BTC_PRICE, USDC_UP);
        _assertZeroSeizureAtomic(d, c);
    }

    function _assertZeroSeizureAtomic(address d, address c) internal {
        uint256 debt = pool.debtBalanceOf(d, bob);
        uint256 col = pool.supplyBalanceOf(c, bob);
        uint256 liqUsdc = usdc.balanceOf(liq);
        uint256 poolUsdc = usdc.balanceOf(address(pool));
        uint256 liqShares = pool.scaledSupplyOf(c, liq);
        vm.prank(liq);
        vm.expectRevert(OrynPool.ZeroSeizure.selector);
        pool.liquidate(bob, d, c, 750); // 750 micro-USDC: just below the 751 threshold
        assertEq(pool.debtBalanceOf(d, bob), debt);
        assertEq(pool.supplyBalanceOf(c, bob), col);
        assertEq(usdc.balanceOf(liq), liqUsdc);
        assertEq(usdc.balanceOf(address(pool)), poolUsdc);
        assertEq(pool.scaledSupplyOf(c, liq), liqShares);
        // one micro-USDC more crosses the threshold and seizes exactly 1 sat
        (uint256 repaid, uint256 seized,) = _liquidate(d, c, 751);
        assertEq(repaid, 751);
        assertEq(seized, 1);
    }

    function test_ZeroSeizure_NotLiquidatableAndZeroAmountPrecedeIt() public {
        (address d, address c) = _build(true, false, 1 * B, 800, false, BTC_PRICE, USDC_UP);
        vm.prank(liq);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.liquidate(bob, d, c, 0);
        _setUsdcPrice(USDC_PRICE); // healthy again: NotLiquidatable, not ZeroSeizure
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, d, c, 1);
    }
}

interface IERC {
    function balanceOf(address) external view returns (uint256);
}
