// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {OrynPool} from "../OrynPool.sol";
import {MockAggregator} from "../test-helpers/MockAggregator.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev USDC priced by its own AggregatorV3 feed: depeg liquidations, combined freshness,
///      invalid/stale USDC feed gating, non-8-decimal scaling, constructor validation.
contract OrynPoolUsdcFeedTest is OrynPoolTestBase {
    uint256 internal constant DEPEG = 90_000_000; // 0.90

    function _lastLiquidation() internal returns (uint256 repaid, uint256 seized, bool paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == OrynPool.Liquidation.selector) {
                (, repaid, seized, paid) = abi.decode(logs[i].data, (address, uint256, uint256, bool));
                return (repaid, seized, paid);
            }
        }
        revert("no Liquidation event");
    }

    /// @dev Relays a fresh EURC (and BTC) round at "now" without touching the USDC feed.
    function _refreshEurcOnly() internal {
        vm.prank(updater);
        feed.pushRound(int256(PRICE), block.timestamp, ++srcRound);
        btcFeed.setRound(int256(btcPriceNow), block.timestamp);
        lastPushTs = block.timestamp;
    }

    function _healthFactor(address u) internal view returns (uint256) {
        return pool.getAccountData(u).healthFactorWad;
    }

    // ================================================================ constructor / state
    function test_Constructor_ZeroUsdcFeedReverts() public {
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(0), address(feed), address(btcFeed));
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(0), address(btcFeed));
    }

    function test_Constructor_UsdcFeedDecimalsAbove18Reverts() public {
        MockAggregator bad = new MockAggregator(19);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(bad), address(feed), address(btcFeed));
        MockAggregator ok = new MockAggregator(18);
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(ok), address(feed), address(btcFeed));
        assertEq(p.usdcFeedDecimals(), 18);
    }

    function test_Constructor_UsdcFeedWithoutCodeReverts() public {
        vm.expectRevert();
        new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), makeAddr("notAFeed"), address(feed), address(btcFeed));
    }

    function test_Constructor_DoesNotRequireUsdcInitialRound() public {
        MockAggregator empty = new MockAggregator(8); // never given a round: timestamp 0
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(empty), address(feed), address(btcFeed));
        assertFalse(p.isPriceFresh());
        assertEq(p.usdcPriceUpdatedAt(), 0);
        assertEq(p.priceUpdatedAt(), 0);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.usdcUsdPrice();
    }

    // ================================================================ priceOf(USDC) follows its feed
    function test_PriceOfUsdc_FollowsFeed() public {
        assertEq(pool.priceOf(address(usdc)), USDC_PRICE);
        assertEq(pool.usdcUsdPrice(), USDC_PRICE);

        skip(1 hours);
        _setUsdcPrice(99_950_000); // 0.9995
        assertEq(pool.priceOf(address(usdc)), 99_950_000);
        assertEq(pool.usdcUsdPrice(), 99_950_000);
        assertEq(pool.getReserveData(address(usdc)).price8, 99_950_000);
        assertEq(pool.priceOf(address(eurc)), PRICE); // EURC unaffected

        skip(1 hours);
        _setUsdcPrice(100_300_000); // 1.003
        assertEq(pool.priceOf(address(usdc)), 100_300_000);
        assertEq(pool.usdcPriceUpdatedAt(), block.timestamp);
    }

    function test_UsdcPrice_ScalesAccountValuation() public {
        _deposit(bob, usdc, 1_000 * M);
        assertEq(pool.getAccountData(bob).collateralValueUsd, 1_000e8);
        skip(1 hours);
        _setUsdcPrice(DEPEG);
        assertEq(pool.getAccountData(bob).collateralValueUsd, 900e8);
        assertEq(pool.getAccountData(bob).borrowLimitUsd, 720e8); // 80% LTV
        assertEq(pool.getAccountData(bob).liquidationLimitUsd, 765e8); // 85% LT
        assertEq(pool.getUserPosition(bob).totalSupplyValueUsd, 900e8);
    }

    // ================================================================ combined freshness
    function test_PriceUpdatedAt_IsOlderOfTwoFeeds() public {
        skip(1 hours);
        _setUsdcPrice(USDC_PRICE); // usdc newer than eurc
        assertEq(pool.usdcPriceUpdatedAt(), START + 1 hours);
        assertEq(pool.priceUpdatedAt(), START);

        skip(1 hours);
        _refreshEurcOnly(); // eurc newer than usdc
        assertEq(pool.priceUpdatedAt(), START + 1 hours);
        assertEq(pool.usdcPriceUpdatedAt(), START + 1 hours);
        skip(1 hours);
        _refreshEurcOnly();
        assertEq(pool.priceUpdatedAt(), START + 1 hours); // usdc is the older one
    }

    function test_Freshness_UsdcBoundaryExactlyMaxAge() public {
        skip(2 days);
        _refreshEurcOnly(); // usdc age == maxPriceAge exactly
        assertTrue(pool.isPriceFresh());
        skip(1);
        _refreshEurcOnly();
        assertFalse(pool.isPriceFresh()); // usdc age == maxPriceAge + 1
    }

    function test_Freshness_RecoversWhenUsdcRefreshed() public {
        skip(2 days + 1);
        _refreshEurcOnly();
        assertFalse(pool.isPriceFresh());
        _setUsdcPrice(USDC_PRICE);
        assertTrue(pool.isPriceFresh());
    }

    // ================================================================ depeg liquidation (USDC collateral)
    function test_Depeg_MakesUsdcCollateralPositionLiquidatable() public {
        _bobPosition(700 * M); // 1000 USDC collateral, 700 EURC debt
        assertGt(_healthFactor(bob), 1e18);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);

        skip(1 hours);
        _setUsdcPrice(DEPEG); // collateral 900 * 85% = 765 < 700 * 1.1022 = 771.54
        assertLt(_healthFactor(bob), 1e18);
        (, uint256 debtUsd,, uint256 liqValue,) = pool.getUserAccount(bob);
        assertGt(debtUsd, liqValue);
    }

    function test_Depeg_LiquidationWorks_EurcDebt_UsdcCollateral() public {
        _bobPosition(700 * M);
        skip(1 hours);
        _setUsdcPrice(DEPEG);

        uint256 debtBefore = pool.debtBalanceOf(address(eurc), bob);
        uint256 supplyBefore = pool.supplyBalanceOf(address(usdc), bob);
        uint256 liqUsdc = usdc.balanceOf(liq);
        uint256 liqEurc = eurc.balanceOf(liq);

        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 700 * M); // capped by 50% close factor
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        assertApproxEqAbs(repaid, debtBefore / 2, 2);
        assertEq(liqEurc - eurc.balanceOf(liq), repaid);
        // seized = repaid * pEURC / pUSDC * 1.05, single floor; pUSDC is the depegged 0.90
        assertEq(seized, _seizeFloor(repaid, PRICE, DEPEG, 1e6, 1e6, 500));
        assertTrue(paid);
        assertEq(usdc.balanceOf(liq) - liqUsdc, seized);
        assertApproxEqAbs(supplyBefore - pool.supplyBalanceOf(address(usdc), bob), seized, 1);
        assertApproxEqAbs(pool.debtBalanceOf(address(eurc), bob), debtBefore - repaid, 1);
        // a depegged USDC seizes MORE USDC than at par for the same repayment
        assertGt(seized, _seizeFloor(repaid, PRICE, USDC_PRICE, 1e6, 1e6, 500));
    }

    function test_Depeg_RepegRestoresHealth() public {
        _bobPosition(700 * M);
        skip(1 hours);
        _setUsdcPrice(DEPEG);
        assertLt(_healthFactor(bob), 1e18);
        skip(1 hours);
        _setUsdcPrice(USDC_PRICE);
        assertGt(_healthFactor(bob), 1e18);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);
    }

    function test_Depeg_BlocksNewBorrowAndWithdrawOfCollateral() public {
        _bobPosition(700 * M);
        skip(1 hours);
        _setUsdcPrice(DEPEG);
        assertEq(pool.maxBorrowable(address(eurc), bob), 0);
        assertEq(pool.maxWithdrawable(address(usdc), bob), 0);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.borrow(address(eurc), 1 * M);
        vm.prank(bob);
        vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
        pool.withdraw(address(usdc), 1 * M);
    }

    // ================================================================ USDC appreciation (USDC debt)
    function test_UsdcPriceRise_MakesUsdcDebtLiquidatable_EurcCollateral() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M); // 1102.2 USD, LTV 75% -> 826.65, LT 80% -> 881.76
        _borrow(bob, usdc, 800 * M);
        assertGt(_healthFactor(bob), 1e18);

        skip(1 hours);
        _setUsdcPrice(115_000_000); // 800 USDC debt now worth 920 USD > 881.76
        assertLt(_healthFactor(bob), 1e18);

        uint256 debtBefore = pool.debtBalanceOf(address(usdc), bob);
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(eurc), 800 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();
        assertApproxEqAbs(repaid, debtBefore / 2, 2);
        assertEq(seized, _seizeFloor(repaid, 115_000_000, PRICE, 1e6, 1e6, 500));
        assertTrue(paid);
    }

    // ================================================================ stale / invalid USDC feed
    function _blocked(uint256 reportedUpdatedAt) internal {
        bytes memory err = abi.encodeWithSelector(OrynPool.StalePrice.selector, reportedUpdatedAt, 2 days);
        assertFalse(pool.isPriceFresh());

        vm.prank(bob);
        vm.expectRevert(err);
        pool.borrow(address(eurc), 1 * M);

        vm.prank(bob); // withdraw while holding debt
        vm.expectRevert(err);
        pool.withdraw(address(usdc), 1 * M);

        vm.prank(liq);
        vm.expectRevert(err);
        pool.liquidate(bob, address(eurc), address(usdc), 1 * M);

        assertEq(pool.maxBorrowable(address(eurc), bob), 0); // views must not revert
        assertEq(pool.maxWithdrawable(address(usdc), bob), 0);
    }

    function _open() internal {
        vm.prank(carol);
        pool.deposit(address(usdc), 100 * M); // never reads a feed
        vm.prank(carol);
        pool.withdraw(address(usdc), 100 * M); // debt-free exit never reads a feed
        vm.prank(alice);
        pool.deposit(address(eurc), 5 * M);
        uint256 debt = pool.debtBalanceOf(address(eurc), bob);
        vm.prank(bob);
        pool.repay(address(eurc), 40 * M);
        assertApproxEqAbs(debt - pool.debtBalanceOf(address(eurc), bob), 40 * M, 1);
        vm.prank(bob);
        pool.repay(address(eurc), type(uint256).max);
        assertEq(pool.debtBalanceOf(address(eurc), bob), 0);
        vm.prank(bob);
        pool.withdraw(address(usdc), type(uint256).max); // debt-free now
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 0);
    }

    function test_UsdcStale_BlocksRiskActions_NotRepayDeposit() public {
        _bobPosition(100 * M);
        skip(2 days + 1);
        _refreshEurcOnly(); // EURC fresh, USDC older than maxPriceAge
        assertEq(pool.priceUpdatedAt(), START);
        assertEq(pool.usdcPriceUpdatedAt(), START);
        _blocked(START);
        _open();
    }

    function test_EurcStale_UsdcFresh_AlsoBlocks() public {
        _bobPosition(100 * M);
        skip(2 days + 1);
        _setUsdcPrice(USDC_PRICE); // only USDC refreshed
        assertEq(pool.usdcPriceUpdatedAt(), block.timestamp);
        assertEq(pool.priceUpdatedAt(), START);
        _blocked(START);
        _open();
    }

    function test_UsdcInvalid_ZeroAnswer() public {
        _bobPosition(100 * M);
        usdcFeed.setRound(0, block.timestamp);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.usdcUsdPrice();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.priceOf(address(usdc));
        assertEq(pool.priceOf(address(eurc)), PRICE); // EURC still readable
        _blocked(START);
        _open();
    }

    function test_UsdcInvalid_NegativeAnswer() public {
        _bobPosition(100 * M);
        usdcFeed.setRound(-1, block.timestamp);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.usdcUsdPrice();
        _blocked(START);
        _open();
    }

    function test_UsdcInvalid_IncompleteRound() public {
        _bobPosition(100 * M);
        usdcFeed.setRaw(7, int256(USDC_PRICE), block.timestamp, block.timestamp, 6);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.usdcUsdPrice();
        _blocked(START);
        _open();
    }

    function test_UsdcInvalid_ZeroUpdatedAt() public {
        _bobPosition(100 * M);
        usdcFeed.setRaw(5, int256(USDC_PRICE), 0, 0, 5);
        assertEq(pool.usdcPriceUpdatedAt(), 0);
        assertEq(pool.priceUpdatedAt(), 0);
        _blocked(0);
        _open();
    }

    function test_UsdcInvalid_RevertingFeed() public {
        _bobPosition(100 * M);
        usdcFeed.setRevert(true);
        assertEq(pool.usdcPriceUpdatedAt(), 0);
        assertEq(pool.priceUpdatedAt(), 0);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.usdcUsdPrice();
        _blocked(0);
        _open();
    }

    function test_UsdcInvalid_FutureTimestamp() public {
        _bobPosition(100 * M);
        usdcFeed.setRound(int256(USDC_PRICE), block.timestamp + 1);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        pool.usdcUsdPrice();
        _blocked(START); // older of (usdc = future, eurc = now) is reported
        skip(1); // clock catches up; EURC feed is still 1s old -> fresh again
        assertTrue(pool.isPriceFresh());
        _open();
    }

    function test_UsdcInvalid_RecoversAndRiskActionsResume() public {
        _bobPosition(100 * M);
        usdcFeed.setRound(0, block.timestamp);
        assertFalse(pool.isPriceFresh());
        skip(1);
        _setUsdcPrice(USDC_PRICE);
        assertTrue(pool.isPriceFresh());
        _borrow(bob, eurc, 1 * M);
        assertGt(pool.maxBorrowable(address(eurc), bob), 0);
    }

    function test_UsdcInvalid_DebtFreeWithdrawAndDepositNeverReadFeed() public {
        _deposit(bob, usdc, 500 * M);
        usdcFeed.setRevert(true);
        _deposit(bob, usdc, 100 * M);
        assertEq(pool.maxWithdrawable(address(usdc), bob), 600 * M); // debt-free view works too
        _withdraw(bob, usdc, type(uint256).max);
        assertEq(pool.supplyBalanceOf(address(usdc), bob), 0);
    }

    function test_UsdcInvalid_ViewsDoNotRevert() public {
        _bobPosition(100 * M);
        usdcFeed.setRevert(true);
        assertFalse(pool.isPriceFresh());
        assertEq(pool.maxBorrowable(address(usdc), bob), 0);
        assertEq(pool.maxBorrowable(address(eurc), carol), 0);
        assertEq(pool.maxWithdrawable(address(usdc), bob), 0);
        assertEq(pool.maxWithdrawable(address(usdc), alice), 10_000 * M); // debt-free
        assertEq(pool.getMarket(address(usdc)).totalSupply, 11_000 * M);
    }

    // ================================================================ non-8-decimal USDC feed
    function _poolWithUsdcFeed(uint8 dec, int256 answer) internal returns (OrynPool p, MockAggregator m) {
        m = new MockAggregator(dec);
        m.setRound(answer, block.timestamp);
        p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(m), address(feed), address(btcFeed));
        _fund(p);
    }

    function _assertDepeggedValuation(OrynPool p) internal {
        assertEq(p.usdcUsdPrice(), DEPEG);
        assertEq(p.priceOf(address(usdc)), DEPEG);
        assertTrue(p.isPriceFresh());
        vm.prank(bob);
        p.deposit(address(usdc), 1_000 * M);
        assertEq(p.getAccountData(bob).collateralValueUsd, 900e8);
        assertEq(p.getAccountData(bob).borrowLimitUsd, 720e8);
    }

    function test_UsdcScaling_18Decimals() public {
        (OrynPool p,) = _poolWithUsdcFeed(18, 0.9e18);
        assertEq(p.usdcFeedDecimals(), 18);
        assertEq(p.feedDecimals(), 8); // EURC feed untouched
        _assertDepeggedValuation(p);
    }

    function test_UsdcScaling_6Decimals() public {
        (OrynPool p,) = _poolWithUsdcFeed(6, 900_000);
        assertEq(p.usdcFeedDecimals(), 6);
        _assertDepeggedValuation(p);
    }

    function test_UsdcScaling_0Decimals() public {
        (OrynPool p,) = _poolWithUsdcFeed(0, 1);
        assertEq(p.usdcUsdPrice(), 1e8);
    }

    function test_UsdcScaling_18Decimals_TruncatesTowardZero() public {
        (OrynPool p,) = _poolWithUsdcFeed(18, 999_999_999_999_999_999);
        assertEq(p.usdcUsdPrice(), 99_999_999);
    }

    function test_UsdcScaling_BorrowEndToEnd_NonEightDecimals() public {
        uint8[2] memory decs = [uint8(18), uint8(6)];
        int256[2] memory answers = [int256(0.9e18), int256(900_000)];
        for (uint256 i; i < 2; ++i) {
            (OrynPool p,) = _poolWithUsdcFeed(decs[i], answers[i]);
            vm.prank(alice);
            p.deposit(address(eurc), 10_000 * M);
            vm.prank(bob);
            p.deposit(address(usdc), 1_000 * M);
            // limit 720 USD / 1.1022 = 653.2 EURC
            uint256 maxB = p.maxBorrowable(address(eurc), bob);
            assertGe(maxB, 653 * M);
            assertLt(maxB, 654 * M);
            vm.prank(bob);
            p.borrow(address(eurc), 653 * M);
            vm.prank(bob);
            vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
            p.borrow(address(eurc), 2 * M);
        }
    }

    function test_UsdcScaling_AnswerRoundingToZeroIsInvalid() public {
        (OrynPool p, MockAggregator m) = _poolWithUsdcFeed(18, 9_999_999_999);
        assertFalse(p.isPriceFresh());
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.usdcUsdPrice();
        m.setRound(10_000_000_000, block.timestamp);
        assertEq(p.usdcUsdPrice(), 1);
        assertTrue(p.isPriceFresh());
    }

    function test_UsdcScaling_HugeAnswerOnLowDecimalsIsInvalidNotOverflow() public {
        (OrynPool p,) = _poolWithUsdcFeed(0, type(int256).max);
        assertFalse(p.isPriceFresh());
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.usdcUsdPrice();
    }

    function testFuzz_UsdcScaling_MatchesExpectedConversion(uint8 dec, uint256 answer) public {
        dec = uint8(bound(dec, 0, 18));
        answer = bound(answer, 1, 1e30);
        (OrynPool p,) = _poolWithUsdcFeed(dec, int256(answer));
        uint256 expected = dec >= 8
            ? answer / (uint256(10) ** uint256(dec - 8))
            : answer * (uint256(10) ** uint256(8 - dec));
        if (expected == 0) {
            assertFalse(p.isPriceFresh());
            vm.expectRevert(OrynPool.InvalidPrice.selector);
            p.usdcUsdPrice();
        } else {
            assertTrue(p.isPriceFresh());
            assertEq(p.usdcUsdPrice(), expected);
            assertEq(p.priceOf(address(usdc)), expected);
        }
    }

    // ================================================================ fuzz: depeg monotonicity
    function testFuzz_UsdcDepeg_HealthFactorMonotonicInUsdcPrice(uint256 p1, uint256 p2) public {
        p1 = bound(p1, 50_000_000, 150_000_000);
        p2 = bound(p2, p1, 150_000_000);
        _bobPosition(500 * M);
        skip(1 hours);
        _setUsdcPrice(p1);
        uint256 hf1 = _healthFactor(bob);
        _setUsdcPrice(p2); // same block: no interest accrues between the two readings
        assertGe(_healthFactor(bob), hf1); // USDC collateral worth more -> never less healthy
    }
}
