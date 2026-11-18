// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev Dynamic close factor (50% / 100% below HF 0.95) and the receiveSupplyShares overload.
///      Position: bob supplies 1 cirBTC (LT 75%, bonus 8%) and owes 60,000 USDC, all at ONE timestamp, so
///      both indexes are exactly 1e18 and no interest accrues. Moving only the BTC price (a mock feed that may
///      change within a block) sets health exactly: HF = 0.75 * btcPrice / 60,000, so BTC = 76,000 is HF 0.95.
contract OrynPoolAaveLiquidationTest is OrynPoolTestBase {
    uint256 internal constant DEBT = 60_000 * M;
    uint256 internal constant BTC_AT_095 = 76_000e8; // liquidation value 57,000 = 0.95 * 60,000 exactly
    uint256 internal constant BONUS = 800; // cirBTC liquidation bonus (bps)

    function setUp() public override {
        super.setUp();
        _deposit(alice, usdc, 50_000_000 * M);
        _deposit(alice, cirbtc, 100 * B);
        _deposit(bob, cirbtc, 1 * B);
        _borrow(bob, usdc, DEBT);
    }

    // ------------------------------------------------------------------ helpers
    function _last() internal returns (address liquidator, uint256 repaid, uint256 seized, bool paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == OrynPool.Liquidation.selector) {
                liquidator = address(uint160(uint256(logs[i].topics[1])));
                (, repaid, seized, paid) = abi.decode(logs[i].data, (address, uint256, uint256, bool));
                return (liquidator, repaid, seized, paid);
            }
        }
        revert("no Liquidation event");
    }

    function _seize(uint256 applied, uint256 btcPrice) internal pure returns (uint256) {
        return _seizeFloor(applied, USDC_PRICE, btcPrice, 1e6, 1e8, BONUS);
    }

    /// @dev Liquidates with the 4-arg overload and returns the emitted amounts.
    function _liq4(uint256 req) internal returns (uint256 repaid, uint256 seized, bool paid) {
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), req);
        (, repaid, seized, paid) = _last();
    }

    function _liq5(uint256 req, bool shares) internal returns (uint256 repaid, uint256 seized, bool paid) {
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), req, shares);
        (, repaid, seized, paid) = _last();
    }

    function _hf() internal view returns (uint256) {
        return pool.getAccountData(bob).healthFactorWad;
    }

    // ------------------------------------------------------------------ constants & view
    function test_Constants() public view {
        assertEq(pool.CLOSE_FACTOR(), 5_000);
        assertEq(pool.MAX_CLOSE_FACTOR(), 10_000);
        assertEq(pool.FULL_CLOSE_HEALTH_THRESHOLD(), 0.95e18);
    }

    function test_CloseFactorView_HealthyAndDebtFreeReturn5000() public {
        assertEq(pool.liquidationCloseFactor(bob), 5_000); // healthy, has debt
        assertEq(pool.liquidationCloseFactor(alice), 5_000); // no debt at all
        assertEq(pool.liquidationCloseFactor(makeAddr("nobody")), 5_000);
    }

    function test_CloseFactorView_BoundaryAt095() public {
        _setBtcPrice(BTC_AT_095);
        assertEq(_hf(), 0.95e18);
        assertEq(pool.liquidationCloseFactor(bob), 5_000); // exactly 0.95 is NOT below
        _setBtcPrice(BTC_AT_095 + 2);
        assertGt(_hf(), 0.95e18);
        assertEq(pool.liquidationCloseFactor(bob), 5_000);
        _setBtcPrice(BTC_AT_095 - 1);
        assertLt(_hf(), 0.95e18);
        assertEq(pool.liquidationCloseFactor(bob), 10_000);
    }

    function test_CloseFactorView_BetweenOneAndPoint95And_WellBelow() public {
        _setBtcPrice(78_000e8); // HF 0.975
        assertLt(_hf(), 1e18);
        assertEq(pool.liquidationCloseFactor(bob), 5_000);
        _setBtcPrice(50_000e8); // HF 0.625
        assertEq(pool.liquidationCloseFactor(bob), 10_000);
    }

    function test_CloseFactorView_WorksWhileStale() public {
        _setBtcPrice(70_000e8);
        skip(2 days + 1);
        assertFalse(pool.isPriceFresh());
        assertEq(pool.liquidationCloseFactor(bob), 10_000); // indicative, does not revert
    }

    // ------------------------------------------------------------------ 50% close factor
    function test_CloseFactor50_AtExactly095() public {
        _setBtcPrice(BTC_AT_095);
        (uint256 repaid, uint256 seized,) = _liq4(type(uint256).max);
        assertEq(repaid, DEBT / 2);
        assertEq(seized, _seize(repaid, BTC_AT_095));
        assertEq(pool.debtBalanceOf(address(usdc), bob), DEBT / 2);
    }

    function test_CloseFactor50_JustAbove095() public {
        _setBtcPrice(BTC_AT_095 + 2);
        assertGt(_hf(), 0.95e18);
        (uint256 repaid,,) = _liq4(type(uint256).max);
        assertEq(repaid, DEBT / 2);
    }

    function test_CloseFactor50_BetweenThresholdAndOne() public {
        _setBtcPrice(79_000e8); // HF ~0.9875
        (uint256 repaid,,) = _liq4(DEBT);
        assertEq(repaid, DEBT / 2);
    }

    function test_CloseFactor50_RequestAboveCapIsCapped() public {
        _setBtcPrice(BTC_AT_095);
        (uint256 repaid,,) = _liq4(40_000 * M);
        assertEq(repaid, 30_000 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 30_000 * M);
    }

    function test_CloseFactor50_RequestBelowCapIsExact() public {
        _setBtcPrice(BTC_AT_095);
        (uint256 repaid,,) = _liq4(10_000 * M);
        assertEq(repaid, 10_000 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 50_000 * M);
    }

    // ------------------------------------------------------------------ 100% close factor
    function test_CloseFactor100_JustBelow095() public {
        _setBtcPrice(BTC_AT_095 - 1);
        assertLt(_hf(), 0.95e18);
        (uint256 repaid, uint256 seized,) = _liq4(type(uint256).max);
        assertEq(repaid, DEBT); // more than the 50% cap
        assertEq(seized, _seize(DEBT, BTC_AT_095 - 1));
        assertEq(pool.debtBalanceOf(address(usdc), bob), 0);
    }

    function test_CloseFactor100_FullDebtLiquidation() public {
        _setBtcPrice(70_000e8); // HF 0.875; seizure 64,800 USD = ~0.926 BTC < 1 BTC collateral
        uint256 liqUsdc = usdc.balanceOf(liq);
        (uint256 repaid, uint256 seized, bool paid) = _liq4(DEBT);
        assertEq(repaid, DEBT);
        assertEq(seized, _seize(DEBT, 70_000e8));
        assertTrue(paid);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 0);
        assertEq(liqUsdc - usdc.balanceOf(liq), DEBT);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1 * B - seized);
    }

    function test_CloseFactor100_PartialRequestIsExact() public {
        _setBtcPrice(70_000e8);
        (uint256 repaid,,) = _liq4(45_000 * M); // above the 50% cap, below full debt
        assertEq(repaid, 45_000 * M);
        assertEq(pool.debtBalanceOf(address(usdc), bob), 15_000 * M);
    }

    function test_CloseFactor100_CollateralCapStillLimitsRepay() public {
        _setBtcPrice(60_000e8); // HF 0.75; 60,000 * 1.08 = 64,800 USD > 60,000 USD collateral
        (uint256 repaid, uint256 seized,) = _liq4(type(uint256).max);
        assertGt(repaid, DEBT / 2); // 100% close factor was in effect
        assertLt(repaid, DEBT); // but collateral binds
        assertEq(seized, _seize(repaid, 60_000e8));
        assertLe(seized, 1 * B);
        assertGt(_seize(repaid + 1, 60_000e8), 1 * B); // repaid is the largest feasible amount
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), 1 * B - seized);
        assertEq(pool.debtBalanceOf(address(usdc), bob), DEBT - repaid);
    }

    // ------------------------------------------------------------------ receiveSupplyShares
    function test_ReceiveSupplyShares_True_GivesSharesNoUnderlyingDespiteAmpleCash() public {
        _setBtcPrice(BTC_AT_095);
        uint256 poolCash = cirbtc.balanceOf(address(pool));
        uint256 liqBtc = cirbtc.balanceOf(liq);
        uint256 liqSupplyBefore = pool.supplyBalanceOf(address(cirbtc), liq);
        uint256 bobSupplyBefore = pool.supplyBalanceOf(address(cirbtc), bob);
        uint256 liqUsdc = usdc.balanceOf(liq);
        assertGt(poolCash, 1 * B); // ample cash

        (uint256 repaid, uint256 seized, bool paid) = _liq5(type(uint256).max, true);

        assertFalse(paid);
        assertEq(repaid, DEBT / 2);
        assertEq(seized, _seize(repaid, BTC_AT_095));
        assertEq(cirbtc.balanceOf(liq), liqBtc); // no underlying
        assertEq(cirbtc.balanceOf(address(pool)), poolCash); // pool cash untouched
        assertEq(pool.supplyBalanceOf(address(cirbtc), liq), liqSupplyBefore + seized);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), bobSupplyBefore - seized);
        assertEq(liqUsdc - usdc.balanceOf(liq), repaid); // liquidator still pays the debt
    }

    function test_ReceiveSupplyShares_True_EmitsLiquidationPaidUnderlyingFalse() public {
        _setBtcPrice(BTC_AT_095);
        uint256 seized = _seize(DEBT / 2, BTC_AT_095);
        vm.expectEmit(true, true, true, true, address(pool));
        emit OrynPool.Liquidation(liq, bob, address(usdc), address(cirbtc), DEBT / 2, seized, false);
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(cirbtc), DEBT, true);
    }

    function test_ReceiveSupplyShares_True_LiquidatorCanWithdrawSharesLater() public {
        _setBtcPrice(BTC_AT_095);
        (, uint256 seized,) = _liq5(DEBT, true);
        uint256 before = cirbtc.balanceOf(liq);
        _withdraw(liq, cirbtc, seized);
        assertEq(cirbtc.balanceOf(liq) - before, seized);
        assertEq(pool.supplyBalanceOf(address(cirbtc), liq), 0);
    }

    function test_ReceiveSupplyShares_False_PaysUnderlyingWhenCashSuffices() public {
        _setBtcPrice(BTC_AT_095);
        uint256 liqBtc = cirbtc.balanceOf(liq);
        uint256 liqShares = pool.scaledSupplyOf(address(cirbtc), liq);
        (, uint256 seized, bool paid) = _liq5(type(uint256).max, false);
        assertTrue(paid);
        assertEq(cirbtc.balanceOf(liq) - liqBtc, seized);
        assertEq(pool.scaledSupplyOf(address(cirbtc), liq), liqShares); // no shares
    }

    function test_ReceiveSupplyShares_False_FallsBackToSharesWithoutCash() public {
        // drain the pool's cirBTC: carol borrows everything alice supplied (bob's 1 BTC included)
        _deposit(carol, usdc, 20_000_000 * M);
        _borrow(carol, cirbtc, cirbtc.balanceOf(address(pool)));
        _setBtcPrice(BTC_AT_095);
        uint256 liqBtc = cirbtc.balanceOf(liq);
        (, uint256 seized, bool paid) = _liq5(type(uint256).max, false);
        assertFalse(paid);
        assertEq(cirbtc.balanceOf(liq), liqBtc);
        assertGt(pool.supplyBalanceOf(address(cirbtc), liq), 0);
        assertLe(pool.supplyBalanceOf(address(cirbtc), liq), seized);
    }

    function test_FourArgOverloadEqualsFiveArgWithFalse() public {
        _setBtcPrice(BTC_AT_095 - 1); // 100% zone makes the comparison stronger
        uint256 snap = vm.snapshotState();

        (uint256 r4, uint256 s4, bool p4) = _liq4(type(uint256).max);
        uint256[6] memory a = _state();

        vm.revertToState(snap);
        (uint256 r5, uint256 s5, bool p5) = _liq5(type(uint256).max, false);
        uint256[6] memory b = _state();

        assertEq(r4, r5);
        assertEq(s4, s5);
        assertEq(p4, p5);
        for (uint256 i; i < 6; ++i) {
            assertEq(a[i], b[i]);
        }
    }

    function _state() internal view returns (uint256[6] memory s) {
        s[0] = pool.debtBalanceOf(address(usdc), bob);
        s[1] = pool.supplyBalanceOf(address(cirbtc), bob);
        s[2] = pool.scaledSupplyOf(address(cirbtc), liq);
        s[3] = cirbtc.balanceOf(liq);
        s[4] = usdc.balanceOf(liq);
        s[5] = cirbtc.balanceOf(address(pool));
    }

    // ------------------------------------------------------------------ guards
    function test_Revert_HealthyAccountNotLiquidatable_BothOverloads() public {
        vm.startPrank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M, true);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M, false);
        vm.stopPrank();
    }

    function test_Revert_HealthExactlyOneNotLiquidatable() public {
        _setBtcPrice(80_000e8); // liquidation value 60,000 == debt 60,000 -> HF exactly 1
        assertEq(_hf(), 1e18);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M, true);
    }

    function test_Revert_DebtFreeBorrowerNotLiquidatable() public {
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(alice, address(usdc), address(cirbtc), 1 * M, true);
    }

    function test_Revert_StalePrices_BothOverloads() public {
        _setBtcPrice(70_000e8);
        uint256 oldest = pool.priceUpdatedAt();
        skip(2 days + 1);
        vm.startPrank(liq);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, oldest, 2 days));
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, oldest, 2 days));
        pool.liquidate(bob, address(usdc), address(cirbtc), 1_000 * M, true);
        vm.stopPrank();
    }

    function test_Revert_ZeroAmountAndZeroBorrower_FiveArg() public {
        _setBtcPrice(70_000e8);
        vm.startPrank(liq);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.liquidate(bob, address(usdc), address(cirbtc), 0, true);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.liquidate(address(0), address(usdc), address(cirbtc), 1, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ fuzz
    /// @dev Over health factor and repay amount: seized value <= repaid value * (1 + bonus), the repaid amount
    ///      respects the close factor reported by the view, and debt never exceeds its pre-liquidation value
    ///      (never goes negative) with bob's collateral and the pool staying solvent.
    function testFuzz_SeizedValueBoundedAndDebtNeverNegative(uint256 btcPrice, uint256 req, bool shares) public {
        btcPrice = bound(btcPrice, 20_000e8, 79_999e8); // HF in ~(0.25, 1)
        req = bound(req, 1 * M, 2 * DEBT);
        _setBtcPrice(btcPrice);
        assertLt(_hf(), 1e18);

        uint256 cf = pool.liquidationCloseFactor(bob);
        assertEq(cf, _hf() < 0.95e18 ? 10_000 : 5_000);
        uint256 colBefore = pool.supplyBalanceOf(address(cirbtc), bob);

        (uint256 repaid, uint256 seized, bool paid) = _liq5(req, shares);

        assertGt(repaid, 0);
        assertLe(repaid, req);
        assertLe(repaid, DEBT * cf / 10_000); // close factor respected
        assertLe(pool.debtBalanceOf(address(usdc), bob), DEBT); // never above original
        assertEq(pool.debtBalanceOf(address(usdc), bob), DEBT - repaid); // never negative / exact
        // seized USD <= repaid USD * (1 + bonus), cross-multiplied exactly
        assertLe(seized * btcPrice * 1e6 * 10_000, repaid * USDC_PRICE * 1e8 * (10_000 + BONUS));
        assertLe(seized, colBefore);
        assertEq(pool.supplyBalanceOf(address(cirbtc), bob), colBefore - seized);
        if (shares) assertFalse(paid);
        else assertTrue(paid); // ample cash
        OrynPool.ReserveData memory rd = pool.getReserveData(address(usdc));
        assertGe(usdc.balanceOf(address(pool)) + rd.totalBorrowed, rd.totalSupplied);
    }
}
