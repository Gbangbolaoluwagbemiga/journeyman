// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Atelier.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Minimal ERC20. Atelier only needs transfer/transferFrom/approve.
contract MockUSDC {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/**
 * Shared fixture for the Autopilot job-manager tests.
 *
 * The cast, and why each one exists:
 *
 *   client      the depositor. Funds the escrow, keeps dispute rights.
 *   manager     the Autopilot agent. May hire, approve, reject — nothing else.
 *   worker      the human freelancer. The only party who may receive payment.
 *   arbiter     steps in when a job escalates.
 *   outsider    holds no role, and must stay unable to do anything.
 */
contract JobManagerBase is Test {
    Atelier internal sf;
    MockUSDC internal usdc;

    address internal client = address(0xC11E27);
    address internal manager = address(0xA9E27);
    address internal worker = address(0x0B0B);
    address internal arbiter = address(0xA4B17E4);
    address internal outsider = address(0x0475107);
    address internal feeCollector = address(0xFEE);

    uint256 internal constant BUDGET = 900e6;
    uint256 internal constant M1 = 300e6;
    uint256 internal constant M2 = 600e6;

    /// The implementation behind the proxy. Kept so upgrade tests can compare.
    Atelier internal implementation;
    ERC1967Proxy internal proxy;

    function setUp() public virtual {
        /*
         * Deployed exactly as production will be: implementation, then proxy,
         * then initialize THROUGH the proxy. Tests that construct the logic
         * contract directly would pass while a real deployment reverted, since
         * the constructor disables initialisers on the implementation.
         */
        implementation = new Atelier();
        proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(Atelier.initialize, (feeCollector, 250)) // 2.5%
        );
        sf = Atelier(payable(address(proxy)));

        usdc = new MockUSDC();
        sf.whitelistToken(address(usdc));
        sf.authorizeArbiter(arbiter);

        usdc.mint(client, 1_000_000e6);
        vm.prank(client);
        usdc.approve(address(sf), type(uint256).max);
    }

    /// Open job (beneficiary address(0)), two milestones, funded by `client`.
    function _createOpenJob() internal returns (uint256 escrowId) {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = M1;
        amounts[1] = M2;

        string[] memory descs = new string[](2);
        descs[0] = "First milestone";
        descs[1] = "Second milestone";

        vm.prank(client);
        escrowId = sf.createEscrow(
            address(0), address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    function _apply(uint256 escrowId, address who) internal {
        vm.prank(who);
        sf.applyToJob(escrowId, "I can do this", 3);
    }

    /// Job funded, manager appointed, worker hired and started.
    function _liveAutopilotJob() internal returns (uint256 escrowId) {
        escrowId = _createOpenJob();

        vm.prank(client);
        sf.setJobManager(escrowId, manager);

        _apply(escrowId, worker);

        vm.prank(manager);
        sf.acceptFreelancer(escrowId, worker);

        vm.prank(worker);
        sf.startWork(escrowId);
    }

    function _submit(uint256 escrowId, uint256 index) internal {
        vm.prank(worker);
        sf.submitMilestone(escrowId, index, "Here is the work");
    }
}
