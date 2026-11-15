// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @dev Test-only feed whose every round field is freely settable, so tests can
///      simulate invalid answers, incomplete rounds, future timestamps and reverting feeds.
contract MockAggregator is AggregatorV3Interface {
    uint8 public override decimals;
    string public override description = "mock";

    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;
    bool public shouldRevert;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    /// @dev Sets a complete, internally consistent round (answeredInRound == roundId).
    function setRound(int256 answer_, uint256 updatedAt_) external {
        roundId = roundId + 1;
        answer = answer_;
        startedAt = updatedAt_;
        updatedAt = updatedAt_;
        answeredInRound = roundId;
    }

    function setRaw(uint80 roundId_, int256 answer_, uint256 startedAt_, uint256 updatedAt_, uint80 answeredInRound_)
        external
    {
        roundId = roundId_;
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setRevert(bool flag) external {
        shouldRevert = flag;
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return _latest();
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return _latest();
    }

    function _latest() private view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
