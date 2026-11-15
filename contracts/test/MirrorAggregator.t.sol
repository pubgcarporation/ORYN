// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MirrorAggregator} from "../MirrorAggregator.sol";

contract MirrorAggregatorTest is Test {
    MirrorAggregator internal agg;

    address internal owner = makeAddr("owner");
    address internal updater = makeAddr("updater");
    address internal other = makeAddr("other");

    uint256 internal constant START = 1_700_000_000;
    int256 internal constant ANSWER = 110_220_000;

    function setUp() public {
        vm.warp(START);
        agg = new MirrorAggregator(owner, updater, 8, "EURC / USD");
    }

    function _push(int256 answer, uint256 ts, uint80 srcId) internal {
        vm.prank(updater);
        agg.pushRound(answer, ts, srcId);
    }

    // ---------------------------------------------------------------- constructor
    function test_Constructor_State() public view {
        assertEq(agg.owner(), owner);
        assertEq(agg.updater(), updater);
        assertEq(agg.decimals(), 8);
        assertEq(agg.description(), "EURC / USD");
        assertEq(agg.version(), 1);
    }

    function test_Constructor_EmitsUpdaterUpdated() public {
        vm.expectEmit(true, true, false, false);
        emit MirrorAggregator.UpdaterUpdated(address(0), updater);
        new MirrorAggregator(owner, updater, 18, "X");
    }

    function test_Constructor_Reverts() public {
        vm.expectRevert(MirrorAggregator.ZeroAddress.selector);
        new MirrorAggregator(owner, address(0), 8, "X");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MirrorAggregator(address(0), updater, 8, "X");
    }

    function test_NoRoundBeforeFirstPush_ReadsRevertNoData() public {
        vm.expectRevert(MirrorAggregator.NoDataPresent.selector);
        agg.latestRoundData();
        vm.expectRevert(MirrorAggregator.NoDataPresent.selector);
        agg.getRoundData(0);
        vm.expectRevert(MirrorAggregator.NoDataPresent.selector);
        agg.getRoundData(1);
    }

    // ---------------------------------------------------------------- pushRound access control
    function test_PushRound_OnlyUpdater() public {
        bytes memory err = abi.encodeWithSelector(MirrorAggregator.UnauthorizedUpdater.selector);
        vm.prank(other);
        vm.expectRevert(err);
        agg.pushRound(ANSWER, START, 1);
        vm.prank(owner); // the owner is NOT the updater
        vm.expectRevert(err);
        agg.pushRound(ANSWER, START, 1);
        vm.expectRevert(err); // test contract itself
        agg.pushRound(ANSWER, START, 1);

        _push(ANSWER, START, 1); // updater succeeds
        (, int256 a,,,) = agg.latestRoundData();
        assertEq(a, ANSWER);
    }

    // ---------------------------------------------------------------- answer validation
    function test_PushRound_NonPositiveAnswerReverts() public {
        vm.startPrank(updater);
        vm.expectRevert(MirrorAggregator.InvalidAnswer.selector);
        agg.pushRound(0, START, 1);
        vm.expectRevert(MirrorAggregator.InvalidAnswer.selector);
        agg.pushRound(-1, START, 1);
        vm.expectRevert(MirrorAggregator.InvalidAnswer.selector);
        agg.pushRound(type(int256).min, START, 1);
        vm.stopPrank();
        vm.expectRevert(MirrorAggregator.NoDataPresent.selector); // nothing was stored
        agg.latestRoundData();
    }

    function test_PushRound_MinimalPositiveAnswerAccepted() public {
        _push(1, START, 1);
        (, int256 a,,,) = agg.latestRoundData();
        assertEq(a, 1);
    }

    // ---------------------------------------------------------------- timestamp ordering
    function test_PushRound_TimestampMustStrictlyIncrease() public {
        _push(ANSWER, START - 100, 1);

        vm.startPrank(updater);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector); // equal
        agg.pushRound(ANSWER + 1, START - 100, 2);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector); // older
        agg.pushRound(ANSWER + 1, START - 101, 2);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector); // much older
        agg.pushRound(ANSWER + 1, 1, 2);
        agg.pushRound(ANSWER + 1, START - 99, 2); // +1 second is enough
        vm.stopPrank();

        (uint80 id, int256 a,, uint256 updatedAt,) = agg.latestRoundData();
        assertEq(id, 2);
        assertEq(a, ANSWER + 1);
        assertEq(updatedAt, START - 99);
    }

    function test_PushRound_ZeroTimestampReverts() public {
        vm.prank(updater);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector);
        agg.pushRound(ANSWER, 0, 1);
    }

    function test_PushRound_FutureTimestampReverts() public {
        vm.prank(updater);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector);
        agg.pushRound(ANSWER, START + 1, 1);
        _push(ANSWER, START, 1); // exactly now is allowed
    }

    function test_PushRound_KeepsSourceTimestamp_NotBlockTime() public {
        skip(1 days);
        uint256 sourceTs = block.timestamp - 20 hours;
        _push(ANSWER, sourceTs, 4242);
        (, , uint256 startedAt, uint256 updatedAt,) = agg.latestRoundData();
        assertEq(updatedAt, sourceTs);
        assertEq(startedAt, sourceTs);
        assertTrue(updatedAt != block.timestamp);
    }

    function test_PushRound_EmitsRoundPushed() public {
        vm.expectEmit(false, false, false, true, address(agg));
        emit MirrorAggregator.RoundPushed(1, ANSWER, START - 5, 777);
        _push(ANSWER, START - 5, 777);
    }

    // ---------------------------------------------------------------- round history
    function test_RoundHistory_SequentialLocalIdsAndRetainedData() public {
        _push(100_000_000, START - 300, 9_001); // source round ids are arbitrary metadata
        _push(101_000_000, START - 200, 5);
        _push(102_000_000, START - 100, 9_999);

        (uint80 id, int256 a, uint256 s, uint256 u, uint80 air) = agg.latestRoundData();
        assertEq(id, 3);
        assertEq(a, 102_000_000);
        assertEq(s, START - 100);
        assertEq(u, START - 100);
        assertEq(air, 3);

        int256[3] memory answers = [int256(100_000_000), 101_000_000, 102_000_000];
        for (uint80 r = 1; r <= 3; ++r) {
            (uint80 rid, int256 ra, uint256 rs, uint256 ru, uint80 rair) = agg.getRoundData(r);
            assertEq(rid, r);
            assertEq(ra, answers[r - 1]);
            assertEq(ru, START - 400 + 100 * uint256(r));
            assertEq(rs, ru);
            assertEq(rair, r);
        }

        vm.expectRevert(MirrorAggregator.NoDataPresent.selector);
        agg.getRoundData(0);
        vm.expectRevert(MirrorAggregator.NoDataPresent.selector);
        agg.getRoundData(4);
    }

    // ---------------------------------------------------------------- setUpdater
    function test_SetUpdater_OwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other);
        vm.prank(other);
        vm.expectRevert(err);
        agg.setUpdater(other);

        vm.prank(updater); // the updater itself cannot rotate the key
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, updater));
        agg.setUpdater(other);
        assertEq(agg.updater(), updater);
    }

    function test_SetUpdater_RotatesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(agg));
        emit MirrorAggregator.UpdaterUpdated(updater, other);
        vm.prank(owner);
        agg.setUpdater(other);
        assertEq(agg.updater(), other);

        vm.prank(updater); // old updater loses access
        vm.expectRevert(MirrorAggregator.UnauthorizedUpdater.selector);
        agg.pushRound(ANSWER, START, 1);

        vm.prank(other); // new updater can push
        agg.pushRound(ANSWER, START, 1);
        (, int256 a,,,) = agg.latestRoundData();
        assertEq(a, ANSWER);
    }

    function test_SetUpdater_ZeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(MirrorAggregator.ZeroAddress.selector);
        agg.setUpdater(address(0));
        assertEq(agg.updater(), updater);
    }

    function test_SetUpdater_PreservesHistory() public {
        _push(ANSWER, START - 10, 1);
        vm.prank(owner);
        agg.setUpdater(other);
        (uint80 id, int256 a,,,) = agg.latestRoundData();
        assertEq(id, 1);
        assertEq(a, ANSWER);
        // the ordering rule persists across updaters
        vm.prank(other);
        vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector);
        agg.pushRound(ANSWER, START - 10, 2);
    }

    // ---------------------------------------------------------------- ownership (Ownable2Step)
    function test_Ownership_TwoStep() public {
        vm.prank(owner);
        agg.transferOwnership(other);
        assertEq(agg.owner(), owner);
        assertEq(agg.pendingOwner(), other);
        vm.prank(other);
        agg.acceptOwnership();
        assertEq(agg.owner(), other);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        agg.setUpdater(owner);
    }

    // ---------------------------------------------------------------- fuzz
    function testFuzz_PushRound_StoresAnswerAndSourceTimestamp(int256 answer, uint256 ts) public {
        answer = bound(answer, 1, type(int256).max);
        ts = bound(ts, 1, block.timestamp);
        _push(answer, ts, 1);
        (uint80 id, int256 a, uint256 s, uint256 u, uint80 air) = agg.latestRoundData();
        assertEq(id, 1);
        assertEq(a, answer);
        assertEq(u, ts);
        assertEq(s, ts);
        assertEq(air, id);
    }

    function testFuzz_PushRound_NonPositiveAlwaysReverts(int256 answer) public {
        answer = bound(answer, type(int256).min, 0);
        vm.prank(updater);
        vm.expectRevert(MirrorAggregator.InvalidAnswer.selector);
        agg.pushRound(answer, START, 1);
    }

    function testFuzz_PushRound_UpdatedAtNeverDecreases(uint256 t1, uint256 t2) public {
        t1 = bound(t1, 1, START);
        t2 = bound(t2, 1, START);
        _push(ANSWER, t1, 1);
        vm.prank(updater);
        if (t2 <= t1) {
            vm.expectRevert(MirrorAggregator.InvalidSourceTimestamp.selector);
            agg.pushRound(ANSWER, t2, 2);
            (,,, uint256 u,) = agg.latestRoundData();
            assertEq(u, t1);
        } else {
            agg.pushRound(ANSWER, t2, 2);
            (,,, uint256 u,) = agg.latestRoundData();
            assertEq(u, t2);
        }
    }
}
