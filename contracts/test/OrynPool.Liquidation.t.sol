// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {OrynPool} from "../OrynPool.sol";
import {OrynPoolTestBase} from "./OrynPool.Base.t.sol";

contract OrynPoolLiquidationTest is OrynPoolTestBase {
    uint256 internal constant P1 = 121_242_000; // PRICE + 10%
    uint256 internal constant P2 = 133_366_200; // P1 + 10%

    /// @dev bob: 1000 USDC collateral, 700 EURC debt. Liquidatable once EURC > ~1.2143 USD.
    ///      A single Chainlink round moves the price straight to P2 (no 10% step limit any more).
    function _raisePriceTwice() internal {
        skip(1 days);
        _setPrice(P2);
    }

    /// @dev EURC at 1.25: bob's 700 EURC debt is ~875 USD vs 850 liquidation value (HF ~0.97), i.e.
    ///      liquidatable but not below 0.95, so the 50% close factor applies (P2 gives HF ~0.91 -> 100%).
    uint256 internal constant P_HALF = 125_000_000;

    function _raisePriceToHalfCloseZone() internal {
        skip(1 days);
        _setPrice(P_HALF);
    }

    function _lastLiquidation() internal returns (uint256 repaid, uint256 seized, bool paid) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = OrynPool.Liquidation.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (, repaid, seized, paid) = abi.decode(logs[i].data, (address, uint256, uint256, bool));
                return (repaid, seized, paid);
            }
        }
        revert("no Liquidation event");
    }

    // ---------------------------------------------------------------- underlying payout (EURC debt / USDC collateral)
    function test_Liquidate_RevertsWhileHealthy() public {
        // (see also test_Liquidate_OnChainlinkDrop_* for the reverse direction)
        _bobPosition(700 * M);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);

        // one 10% step is still not enough (848.7 debt vs 850 liquidation value)
        skip(1 days);
        _setPrice(P1);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);
    }

    function test_Liquidate_CloseFactor50_Bonus5_UnderlyingPayout() public {
        _bobPosition(700 * M);
        _raisePriceToHalfCloseZone();

        uint256 debtBefore = pool.debtBalanceOf(address(eurc), bob);
        uint256 supplyBefore = pool.supplyBalanceOf(address(usdc), bob);
        uint256 liqEurc = eurc.balanceOf(liq);
        uint256 liqUsdc = usdc.balanceOf(liq);

        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 700 * M); // asks for 100%, gets capped
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        // close factor: at most 50% of the debt (allow 1 wei of share rounding)
        assertLe(repaid, debtBefore / 2 + 1);
        assertGe(repaid, debtBefore / 2 - 1);
        assertEq(liqEurc - eurc.balanceOf(liq), repaid);
        assertApproxEqAbs(pool.debtBalanceOf(address(eurc), bob), debtBefore - repaid, 1);

        // seized = floor(repaid * price(EURC) * 10,500 / (price(USDC) * 10,000)), single floor rounding
        uint256 expected = _seizeFloor(repaid, P_HALF, 1e8, 1e6, 1e6, 500);
        assertEq(seized, expected);
        assertTrue(paid);
        assertEq(usdc.balanceOf(liq) - liqUsdc, seized); // paid in underlying USDC
        assertEq(pool.scaledSupplyOf(address(usdc), liq), 0); // no share transfer
        assertApproxEqAbs(supplyBefore - pool.supplyBalanceOf(address(usdc), bob), seized, 1);

        // 5% bonus: seized USD value / repaid USD value == 1.05
        uint256 repaidUsd = repaid * P_HALF / 1e6;
        uint256 seizedUsd = seized * 1e8 / 1e6;
        assertApproxEqRel(seizedUsd, repaidUsd * 105 / 100, 1e12);
    }

    function test_Liquidate_EmitsEvent() public {
        _bobPosition(700 * M);
        _raisePriceTwice();
        // topics: liquidator, borrower, debtAsset checked; amounts checked separately above
        vm.expectEmit(true, true, true, false, address(pool));
        emit OrynPool.Liquidation(liq, bob, address(eurc), address(usdc), 0, 0, true);
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 50 * M);
    }

    function test_Liquidate_SmallRepayIsExactAndBelowCloseFactor() public {
        _bobPosition(700 * M);
        _raisePriceTwice();
        uint256 debtBefore = pool.debtBalanceOf(address(eurc), bob);
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);
        (uint256 repaid,,) = _lastLiquidation();
        assertEq(repaid, 100 * M);
        assertApproxEqAbs(pool.debtBalanceOf(address(eurc), bob), debtBefore - 100 * M, 1);
    }

    function test_Liquidate_SecondCallRepaysHalfOfRemainingDebt() public {
        _bobPosition(700 * M);
        _raisePriceToHalfCloseZone();
        // A full 50% first repay would make bob healthy again at HF >= 0.95 (a 50% close can only keep an
        // account liquidatable below HF ~0.946), so the first call repays a small slice.
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 10 * M);
        uint256 debtMid = pool.debtBalanceOf(address(eurc), bob);

        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 700 * M);
        (uint256 repaid,,) = _lastLiquidation();
        assertLe(repaid, debtMid / 2 + 1);
        assertGe(repaid, debtMid / 2 - 1);
    }

    function test_Liquidate_ReverseDirection_UsdcDebtEurcCollateral() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M);
        _borrow(bob, usdc, 800 * M); // cap is 826.65
        skip(1 days);

        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(eurc), 100 * M);

        uint256 pLow = PRICE - PRICE / 10; // 0.99198: liquidation value 793.6 < 800
        _setPrice(pLow);
        uint256 debtBefore = pool.debtBalanceOf(address(usdc), bob);
        uint256 liqEurc = eurc.balanceOf(liq);

        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(eurc), 1_000 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        assertLe(repaid, debtBefore / 2 + 1);
        assertGe(repaid, debtBefore / 2 - 1);
        assertEq(seized, _seizeFloor(repaid, 1e8, pLow, 1e6, 1e6, 500));
        assertTrue(paid);
        assertEq(eurc.balanceOf(liq) - liqEurc, seized);
    }

    // ---------------------------------------------------------------- Chainlink price drop
    /// @dev bob: 1000 EURC collateral, 800 USDC debt (cap 826.65). A drop of EURC/USD to 0.90 makes the
    ///      liquidation value 720 < 800 debt.
    function test_Liquidate_OnChainlinkDrop_BecomesLiquidatableThenSucceeds() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M);
        _borrow(bob, usdc, 800 * M);

        // healthy at the current price
        assertGe(pool.getAccountData(bob).healthFactorWad, 1e18);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(eurc), 100 * M);

        // Chainlink round: EURC/USD drops to 0.90
        skip(1 hours);
        uint256 pDrop = 90_000_000;
        _setPrice(pDrop);
        assertEq(pool.eurUsdPrice(), pDrop);
        OrynPool.AccountData memory d = pool.getAccountData(bob);
        assertLt(d.healthFactorWad, 1e18);
        assertGt(d.borrowValueUsd, d.liquidationLimitUsd);

        uint256 debtBefore = pool.debtBalanceOf(address(usdc), bob);
        uint256 liqEurc = eurc.balanceOf(liq);
        uint256 liqUsdc = usdc.balanceOf(liq);
        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(eurc), 200 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        assertApproxEqAbs(repaid, 200 * M, 1);
        assertEq(seized, _seizeFloor(repaid, 1e8, pDrop, 1e6, 1e6, 500)); // 233.33 EURC incl. 5% bonus
        assertTrue(paid);
        assertEq(liqUsdc - usdc.balanceOf(liq), repaid);
        assertEq(eurc.balanceOf(liq) - liqEurc, seized);
        assertApproxEqAbs(pool.debtBalanceOf(address(usdc), bob), debtBefore - repaid, 1);
        assertApproxEqAbs(pool.supplyBalanceOf(address(eurc), bob), 1_000 * M - seized, 1);
    }

    function test_Liquidate_PriceRecoveryMakesPositionHealthyAgain() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M);
        _borrow(bob, usdc, 800 * M);
        skip(1 hours);
        _setPrice(90_000_000);
        assertLt(pool.getAccountData(bob).healthFactorWad, 1e18);
        skip(1 hours);
        _setPrice(PRICE);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(usdc), address(eurc), 100 * M);
    }

    function test_Liquidate_UnderwaterButStaleFeedBlocksLiquidation_FreshRoundUnblocks() public {
        _liquidity();
        _deposit(bob, eurc, 1_000 * M);
        _borrow(bob, usdc, 800 * M);
        skip(1 hours);
        _setPrice(90_000_000);
        uint256 pushedAt = lastPushTs;

        skip(2 days + 1); // feed heartbeat missed
        vm.prank(liq);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.StalePrice.selector, pushedAt, 2 days));
        pool.liquidate(bob, address(usdc), address(eurc), 100 * M);

        _setPrice(90_000_000); // new round with fresh source timestamp, same answer
        vm.prank(liq);
        pool.liquidate(bob, address(usdc), address(eurc), 100 * M);
        assertLt(pool.debtBalanceOf(address(usdc), bob), 800 * M);
    }

    // ---------------------------------------------------------------- share payout (collateral market has no cash)
    function _noCashScenario() internal {
        _deposit(alice, eurc, 10_000 * M); // only EURC liquidity
        _deposit(carol, eurc, 5_000 * M);
        _deposit(bob, usdc, 1_000 * M);
        _borrow(carol, usdc, 995 * M); // drains USDC cash down to 5
        _borrow(bob, eurc, 700 * M);
        assertEq(usdc.balanceOf(address(pool)), 5 * M);
    }

    function test_Liquidate_SharePayoutWhenCollateralMarketHasNoCash() public {
        _noCashScenario();
        _raisePriceTwice();

        uint256 liqUsdcWallet = usdc.balanceOf(liq);
        uint256 supplyBefore = pool.supplyBalanceOf(address(usdc), bob);
        uint256 poolUsdc = usdc.balanceOf(address(pool));

        vm.recordLogs();
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 700 * M);
        (uint256 repaid, uint256 seized, bool paid) = _lastLiquidation();

        assertFalse(paid);
        assertEq(seized, _seizeFloor(repaid, P2, 1e8, 1e6, 1e6, 500));
        assertGt(seized, poolUsdc); // cash really was insufficient
        // no underlying moved
        assertEq(usdc.balanceOf(liq), liqUsdcWallet);
        assertEq(usdc.balanceOf(address(pool)), poolUsdc);
        // supply claim moved from bob to the liquidator (liquidator never gets more than seized)
        assertApproxEqAbs(pool.supplyBalanceOf(address(usdc), liq), seized, 2);
        assertLe(pool.supplyBalanceOf(address(usdc), liq), seized);
        assertApproxEqAbs(supplyBefore - pool.supplyBalanceOf(address(usdc), bob), seized, 2);

        // the liquidator cannot cash the claim out beyond available cash
        uint256 claim = pool.supplyBalanceOf(address(usdc), liq);
        vm.prank(liq);
        vm.expectRevert(
            abi.encodeWithSelector(OrynPool.InsufficientLiquidity.selector, address(usdc), claim, poolUsdc)
        );
        pool.withdraw(address(usdc), claim);
        _withdraw(liq, usdc, poolUsdc);
        // accounting remains consistent (views would revert with AccountingDeficit otherwise)
        assertGe(pool.getReserveData(address(usdc)).totalSupplied, 0);
    }

    // ---------------------------------------------------------------- pause / guards
    function test_Liquidate_WorksWhilePaused() public {
        _bobPosition(700 * M);
        _raisePriceTwice();
        vm.prank(owner);
        pool.pause();
        uint256 before = pool.debtBalanceOf(address(eurc), bob);
        vm.prank(liq);
        pool.liquidate(bob, address(eurc), address(usdc), 100 * M);
        assertLt(pool.debtBalanceOf(address(eurc), bob), before);
    }

    function test_Liquidate_Reverts() public {
        _bobPosition(700 * M);
        _raisePriceTwice();
        vm.startPrank(liq);
        vm.expectRevert(OrynPool.ZeroAddress.selector);
        pool.liquidate(address(0), address(eurc), address(usdc), 1);
        vm.expectRevert(OrynPool.ZeroAmount.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 0);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.liquidate(bob, address(0x1234), address(usdc), 1);
        vm.expectRevert(abi.encodeWithSelector(OrynPool.UnsupportedAsset.selector, address(0x1234)));
        pool.liquidate(bob, address(eurc), address(0x1234), 1);
        // bob holds no EURC collateral
        vm.expectRevert(OrynPool.InsufficientSupply.selector);
        pool.liquidate(bob, address(eurc), address(eurc), 1 * M);
        // account without debt
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(alice, address(eurc), address(usdc), 1 * M);
        vm.stopPrank();
    }

    function test_Liquidate_RepaidFullDebtBorrowerNotLiquidatable() public {
        _bobPosition(700 * M);
        _raisePriceTwice();
        _repay(bob, eurc, type(uint256).max);
        vm.prank(liq);
        vm.expectRevert(OrynPool.NotLiquidatable.selector);
        pool.liquidate(bob, address(eurc), address(usdc), 1 * M);
    }
}
