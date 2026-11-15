// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/**
 * @title MirrorAggregator
 * @notice TESTNET ONLY: relays existing Chainlink answers with their ORIGINAL timestamps.
 * @dev This is a trusted relay, not an independently verified Chainlink oracle. The updater
 * must copy the source answer and source updatedAt unchanged: staleness is judged against
 * Chainlink's own update time, NEVER the relay time. For Arc Testnet EURC/USD, mirror the
 * Arc mainnet proxy 0x361b95c10b76Ca3f35C686d423e43A951755Bf23 (8 decimals, 24h heartbeat).
 * Local sequential round IDs index history; source round IDs are event metadata only.
 */
contract MirrorAggregator is Ownable2Step, AggregatorV3Interface {
    uint8 public immutable override decimals;
    string public override description;
    address public updater;

    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint80 private _latestRoundId;
    mapping(uint80 roundId => Round) private _rounds;

    error ZeroAddress();
    error UnauthorizedUpdater();
    error InvalidAnswer();
    error InvalidSourceTimestamp();
    error NoDataPresent();

    event UpdaterUpdated(address indexed previousUpdater, address indexed newUpdater);
    event RoundPushed(uint80 roundId, int256 answer, uint256 sourceUpdatedAt, uint80 sourceRoundId);

    constructor(address initialOwner, address updater_, uint8 decimals_, string memory description_)
        Ownable(initialOwner)
    {
        if (updater_ == address(0)) revert ZeroAddress();
        decimals = decimals_;
        description = description_;
        updater = updater_;
        emit UpdaterUpdated(address(0), updater_);
    }

    function setUpdater(address newUpdater) external onlyOwner {
        if (newUpdater == address(0)) revert ZeroAddress();
        address previousUpdater = updater;
        updater = newUpdater;
        emit UpdaterUpdated(previousUpdater, newUpdater);
    }

    /// @notice Relays the source answer and its original update timestamp, not block.timestamp.
    /// @dev Strict timestamp ordering prevents replay. sourceRoundId is emitted, not a local key.
    function pushRound(int256 answer, uint256 sourceUpdatedAt, uint80 sourceRoundId) external {
        if (msg.sender != updater) revert UnauthorizedUpdater();
        if (answer <= 0) revert InvalidAnswer();
        if (sourceUpdatedAt <= _rounds[_latestRoundId].updatedAt || sourceUpdatedAt > block.timestamp) {
            revert InvalidSourceTimestamp();
        }
        uint80 roundId = ++_latestRoundId;
        _rounds[roundId] = Round(answer, sourceUpdatedAt, sourceUpdatedAt);
        emit RoundPushed(roundId, answer, sourceUpdatedAt, sourceRoundId);
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function latestRoundData() external view override returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return _roundData(_latestRoundId);
    }

    function getRoundData(uint80 roundId) external view override returns (
        uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return _roundData(roundId);
    }

    function _roundData(uint80 roundId) private view returns (uint80, int256, uint256, uint256, uint80) {
        Round storage round = _rounds[roundId];
        if (round.updatedAt == 0) revert NoDataPresent();
        return (roundId, round.answer, round.startedAt, round.updatedAt, roundId);
    }
}
