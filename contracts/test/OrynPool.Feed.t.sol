// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OrynPool} from "../OrynPool.sol";
import {MirrorAggregator} from "../MirrorAggregator.sol";
import {MockAggregator} from "../test-helpers/MockAggregator.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

/// @dev Feed decimals scaling, invalid/unreadable feed answers, and views on an empty feed.
contract OrynPoolFeedTest is OrynPoolTestBase {
    // ================================================================ decimals scaling
    function _poolWithMirror(uint8 dec, int256 answer) internal returns (OrynPool p, MirrorAggregator f) {
        f = new MirrorAggregator(owner, updater, dec, "EURC / USD");
        p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(f), address(btcFeed));
        _fund(p);
        vm.prank(updater);
        f.pushRound(answer, block.timestamp, 1);
    }

    function _assertBorrowLimitForEurcCollateral(OrynPool p) internal {
        vm.prank(bob);
        p.deposit(address(eurc), 1_000 * M);
        // 1000 EURC * 1.1022 * 75% LTV = 826.65 USD
        assertEq(p.getAccountData(bob).borrowLimitUsd, 82_665_000_000);
        assertEq(p.getAccountData(bob).collateralValueUsd, 110_220_000_000);
    }

    function test_Scaling_8Decimals_Identity() public view {
        assertEq(pool.feedDecimals(), 8);
        assertEq(pool.eurUsdPrice(), PRICE);
    }

    function test_Scaling_18Decimals_DividesBy1e10() public {
        (OrynPool p,) = _poolWithMirror(18, 1_102_200_000_000_000_000);
        assertEq(p.feedDecimals(), 18);
        assertEq(p.eurUsdPrice(), 110_220_000);
        assertEq(p.priceOf(address(eurc)), 110_220_000);
        assertEq(p.priceOf(address(usdc)), USDC_PRICE);
        assertTrue(p.isPriceFresh());
        _assertBorrowLimitForEurcCollateral(p);
    }

    function test_Scaling_18Decimals_TruncatesTowardZero() public {
        (OrynPool p,) = _poolWithMirror(18, 1_102_200_099_999_999_999);
        assertEq(p.eurUsdPrice(), 110_220_009);
    }

    function test_Scaling_6Decimals_MultipliesBy100() public {
        (OrynPool p,) = _poolWithMirror(6, 1_102_200);
        assertEq(p.feedDecimals(), 6);
        assertEq(p.eurUsdPrice(), 110_220_000);
        assertEq(p.priceOf(address(eurc)), 110_220_000);
        assertTrue(p.isPriceFresh());
        _assertBorrowLimitForEurcCollateral(p);
    }

    function test_Scaling_0Decimals_Multiplies1e8() public {
        (OrynPool p,) = _poolWithMirror(0, 2);
        assertEq(p.eurUsdPrice(), 2e8);
    }

    function test_Scaling_BorrowWorksEndToEndOn18And6DecimalFeeds() public {
        uint8[2] memory decs = [uint8(18), uint8(6)];
        int256[2] memory answers = [int256(1_102_200_000_000_000_000), int256(1_102_200)];
        for (uint256 i; i < 2; ++i) {
            (OrynPool p,) = _poolWithMirror(decs[i], answers[i]);
            vm.prank(alice);
            p.deposit(address(usdc), 10_000 * M);
            vm.prank(bob);
            p.deposit(address(eurc), 1_000 * M);
            uint256 maxB = p.maxBorrowable(address(usdc), bob);
            assertGe(maxB, 826 * M);
            assertLt(maxB, 827 * M);
            vm.prank(bob);
            p.borrow(address(usdc), 826 * M);
            vm.prank(bob);
            vm.expectRevert(OrynPool.InsufficientBorrowCapacity.selector);
            p.borrow(address(usdc), 2 * M);
        }
    }

    function test_Scaling_AnswerRoundingToZeroIsInvalid() public {
        // 18 decimals: anything below 1e10 maps to < 1e-8 USD -> price8 == 0
        MockAggregator m = new MockAggregator(18);
        m.setRound(9_999_999_999, block.timestamp);
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(m), address(btcFeed));
        assertFalse(p.isPriceFresh());
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        assertEq(p.maxBorrowable(address(usdc), bob), 0);

        m.setRound(10_000_000_000, block.timestamp); // exactly 1e-8 -> price8 == 1
        assertEq(p.eurUsdPrice(), 1);
        assertTrue(p.isPriceFresh());
    }

    function test_Scaling_HugeAnswerOnLowDecimalsFeedIsInvalidNotOverflow() public {
        MockAggregator m = new MockAggregator(0);
        m.setRound(type(int256).max, block.timestamp); // * 1e8 would overflow uint256
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(m), address(btcFeed));
        assertFalse(p.isPriceFresh());
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
    }

    function testFuzz_Scaling_MatchesExpectedConversion(uint8 dec, uint256 answer) public {
        dec = uint8(bound(dec, 0, 18));
        answer = bound(answer, 1, 1e30);
        MockAggregator m = new MockAggregator(dec);
        m.setRound(int256(answer), block.timestamp);
        OrynPool p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(m), address(btcFeed));
        uint256 expected = dec >= 8
            ? answer / (uint256(10) ** uint256(dec - 8))
            : answer * (uint256(10) ** uint256(8 - dec));
        if (expected == 0) {
            assertFalse(p.isPriceFresh());
            vm.expectRevert(OrynPool.InvalidPrice.selector);
            p.eurUsdPrice();
        } else {
            assertTrue(p.isPriceFresh());
            assertEq(p.eurUsdPrice(), expected);
        }
    }

    // ================================================================ invalid / unreadable feed answers
    function _mockPoolWithBorrower() internal returns (OrynPool p, MockAggregator m) {
        m = new MockAggregator(8);
        m.setRound(int256(PRICE), block.timestamp);
        p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(m), address(btcFeed));
        _fund(p);
        vm.startPrank(alice);
        p.deposit(address(usdc), 10_000 * M);
        p.deposit(address(eurc), 10_000 * M);
        vm.stopPrank();
        vm.startPrank(bob);
        p.deposit(address(usdc), 1_000 * M);
        p.borrow(address(eurc), 100 * M);
        vm.stopPrank();
    }

    function _assertRiskActionsBlocked(OrynPool p, uint256 reportedUpdatedAt) internal {
        bytes memory err = abi.encodeWithSelector(OrynPool.StalePrice.selector, reportedUpdatedAt, 2 days);
        assertFalse(p.isPriceFresh());

        vm.prank(bob);
        vm.expectRevert(err);
        p.borrow(address(eurc), 1 * M);

        vm.prank(bob); // withdraw while holding debt
        vm.expectRevert(err);
        p.withdraw(address(usdc), 1 * M);

        vm.prank(liq);
        vm.expectRevert(err);
        p.liquidate(bob, address(eurc), address(usdc), 1 * M);

        assertEq(p.maxBorrowable(address(eurc), bob), 0); // view does not revert
        assertEq(p.maxWithdrawable(address(usdc), bob), 0);
    }

    function _assertNonRiskActionsOpen(OrynPool p) internal {
        vm.prank(carol);
        p.deposit(address(usdc), 100 * M);
        vm.prank(carol);
        p.withdraw(address(usdc), 100 * M); // debt-free withdraw
        vm.prank(alice);
        p.deposit(address(eurc), 5 * M);
        vm.prank(bob);
        p.repay(address(eurc), 40 * M);
        assertEq(p.debtBalanceOf(address(eurc), bob), 60 * M);
        vm.prank(bob);
        p.repay(address(eurc), type(uint256).max);
        assertEq(p.debtBalanceOf(address(eurc), bob), 0);
        vm.prank(bob);
        p.withdraw(address(usdc), type(uint256).max); // debt-free now
    }

    function test_InvalidFeed_ZeroAnswer_BlocksRiskActions_NotRepayDeposit() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRound(0, block.timestamp);
        uint256 ts = block.timestamp;
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        assertEq(p.priceUpdatedAt(), ts);
        _assertRiskActionsBlocked(p, ts);
        _assertNonRiskActionsOpen(p);
    }

    function test_InvalidFeed_NegativeAnswer_BlocksRiskActions_NotRepayDeposit() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRound(-1, block.timestamp);
        uint256 ts = block.timestamp;
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        _assertRiskActionsBlocked(p, ts);
        _assertNonRiskActionsOpen(p);
    }

    function test_InvalidFeed_ZeroUpdatedAt_Blocks() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRaw(5, int256(PRICE), 0, 0, 5);
        _assertRiskActionsBlocked(p, 0);
        _assertNonRiskActionsOpen(p);
    }

    function test_InvalidFeed_IncompleteRound_AnsweredInRoundBelowRoundId_Blocks() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRaw(7, int256(PRICE), block.timestamp, block.timestamp, 6);
        uint256 ts = block.timestamp;
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        _assertRiskActionsBlocked(p, ts);
        _assertNonRiskActionsOpen(p);
    }

    function test_InvalidFeed_RevertingFeed_Blocks() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRevert(true);
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        assertEq(p.priceUpdatedAt(), 0);
        _assertRiskActionsBlocked(p, 0);
        _assertNonRiskActionsOpen(p);
    }

    function test_InvalidFeed_FutureTimestamp_TreatedAsStale() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        uint256 future = block.timestamp + 1;
        m.setRound(int256(PRICE), future);
        vm.expectRevert(OrynPool.InvalidPrice.selector); // a future-dated round is rejected as invalid
        p.eurUsdPrice();
        assertEq(p.priceUpdatedAt(), block.timestamp); // older of (USDC = now, EURC = future)
        _assertRiskActionsBlocked(p, block.timestamp);
        skip(1); // once the clock catches up it is fresh again
        assertTrue(p.isPriceFresh());
    }

    function test_InvalidFeed_RecoversWhenFeedReturnsValidRound() public {
        (OrynPool p, MockAggregator m) = _mockPoolWithBorrower();
        m.setRound(0, block.timestamp);
        assertFalse(p.isPriceFresh());
        skip(1);
        m.setRound(int256(PRICE), block.timestamp);
        assertTrue(p.isPriceFresh());
        vm.prank(bob);
        p.borrow(address(eurc), 1 * M);
    }

    // ================================================================ views on empty feed
    function _emptyFeedPool() internal returns (OrynPool p, MirrorAggregator f) {
        f = new MirrorAggregator(owner, updater, 8, "EURC / USD");
        p = new OrynPool(owner, address(usdc), address(eurc), address(cirbtc), address(usdcFeed), address(f), address(btcFeed));
        _fund(p);
    }

    function test_EmptyFeed_FreshnessAndBorrowViewsDoNotRevert() public {
        (OrynPool p,) = _emptyFeedPool();
        assertFalse(p.isPriceFresh());
        assertEq(p.priceUpdatedAt(), 0);
        assertEq(p.maxBorrowable(address(usdc), bob), 0);
        assertEq(p.maxBorrowable(address(eurc), bob), 0);
        assertEq(p.maxWithdrawable(address(usdc), bob), 0); // nothing deposited, debt-free

        vm.prank(bob);
        p.deposit(address(usdc), 100 * M); // deposit never reads the feed
        assertEq(p.maxWithdrawable(address(usdc), bob), 100 * M); // debt-free exit is open
        assertEq(p.maxBorrowable(address(eurc), bob), 0);
        assertEq(p.getMarket(address(usdc)).totalSupply, 100 * M); // price-free view still works
    }

    function test_EmptyFeed_PricedAccessorRevertsInvalidPrice() public {
        (OrynPool p,) = _emptyFeedPool();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurUsdPrice();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.eurcUsdPrice();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.priceOf(address(eurc));
        assertEq(p.priceOf(address(usdc)), USDC_PRICE); // USDC has its own (valid) feed
    }

    function test_EmptyFeed_BorrowAndLiquidateRevertStale_DepositWithdrawWork() public {
        (OrynPool p,) = _emptyFeedPool();
        vm.startPrank(alice);
        p.deposit(address(eurc), 1_000 * M);
        vm.stopPrank();
        vm.startPrank(bob);
        p.deposit(address(usdc), 1_000 * M);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, 0, 2 days));
        p.borrow(address(eurc), 1 * M);
        vm.stopPrank();
        vm.prank(liq);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, 0, 2 days));
        p.liquidate(bob, address(eurc), address(usdc), 1 * M);
        vm.prank(bob);
        p.withdraw(address(usdc), type(uint256).max);
        assertEq(p.supplyBalanceOf(address(usdc), bob), 0);
    }

    function test_EmptyFeed_BecomesUsableAfterFirstPush() public {
        (OrynPool p, MirrorAggregator f) = _emptyFeedPool();
        vm.prank(alice);
        p.deposit(address(eurc), 1_000 * M);
        vm.prank(bob);
        p.deposit(address(usdc), 1_000 * M);

        vm.prank(updater);
        f.pushRound(int256(PRICE), block.timestamp, 1);
        assertTrue(p.isPriceFresh());
        assertEq(p.eurUsdPrice(), PRICE);
        assertGt(p.maxBorrowable(address(eurc), bob), 0);
        vm.prank(bob);
        p.borrow(address(eurc), 100 * M);
        assertEq(p.debtBalanceOf(address(eurc), bob), 100 * M);
    }

    function test_EmptyFeed_GetReserveDataRevertsInvalidPrice_Documented() public {
        (OrynPool p,) = _emptyFeedPool();
        vm.expectRevert(OrynPool.InvalidPrice.selector);
        p.getReserveData(address(eurc));
    }
}
