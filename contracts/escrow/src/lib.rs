//! Foundational ATTESTRA escrow state and accounting.
//!
//! Phase 1C.2A intentionally stops before verification submission, payment
//! settlement, refunds, and cross-contract transfers. Those paths must build
//! on the state and invariants established here.

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

const MAX_MILESTONES_PER_PROJECT: u64 = 128;
const MAX_DEPENDENCIES_PER_MILESTONE: usize = 32;
const MAX_PROJECT_PAGE_SIZE: u64 = 50;
const MAX_RECEIPT_ID_LENGTH: usize = 128;
const MAX_DIGEST_LENGTH: usize = 256;
// Reserve enough gas for one authenticated callback, two bounded map writes,
// accounting updates, and event logging. This remains subject to Testnet
// measurement; it is not a recovery mechanism if a callback never executes.
const CALLBACK_GAS: Gas = Gas::from_tgas(20);

fn checked_add(left: u128, right: u128, message: &str) -> u128 {
    left.checked_add(right)
        .unwrap_or_else(|| env::panic_str(message))
}

fn checked_sub(left: u128, right: u128, message: &str) -> u128 {
    left.checked_sub(right)
        .unwrap_or_else(|| env::panic_str(message))
}

fn checked_increment(value: u64, message: &str) -> u64 {
    value
        .checked_add(1)
        .unwrap_or_else(|| env::panic_str(message))
}

fn require_one_yocto() {
    assert_eq!(
        env::attached_deposit(),
        NearToken::from_yoctonear(1),
        "Requires exactly 1 yoctoNEAR"
    );
}

fn require_bounded_length(value: &str, maximum: usize, message: &str) {
    assert!(value.len() <= maximum, "{message}");
}

fn storage_cost_for_delta(before: u64, after: u64) -> u128 {
    let delta = after.saturating_sub(before);
    NearToken::from_yoctonear(delta as u128 * env::storage_byte_cost().as_yoctonear())
        .as_yoctonear()
}

fn assert_storage_deposit_is_sufficient(required: u128) {
    let attached = env::attached_deposit().as_yoctonear();
    assert!(
        attached >= required,
        "Insufficient storage deposit: required {required} yoctoNEAR"
    );
}

/// Charges verification growth against the project's existing storage credit
/// when the caller is a restricted FunctionCall-key signer. FunctionCall keys
/// cannot attach a positive deposit, so this path is limited to zero-deposit
/// verification and fails closed when credit is insufficient.
fn charge_verification_storage(project: &mut Project, required: u128) {
    let attached = env::attached_deposit().as_yoctonear();
    if attached == 0 {
        assert!(
            project.storage_deposit >= required,
            "Insufficient project storage credit: required {required} yoctoNEAR"
        );
        project.storage_deposit = checked_sub(
            project.storage_deposit,
            required,
            "Project storage credit underflow",
        );
    } else {
        assert_storage_deposit_is_sufficient(required);
        project.storage_deposit = checked_add(
            project.storage_deposit,
            attached,
            "Storage deposit overflow",
        );
    }
}

fn emit_event(event: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "standard": "attestra-escrow",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Projects,
    UsedReceiptIds,
    Milestones { project_id: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MilestoneStatus {
    Created,
    Funded,
    InProgress,
    VerificationFailed,
    VerificationPassed,
    OwnerApproved,
    PaymentPending,
    Paid,
    Cancelled,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerificationResult {
    Passed,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct VerificationAttestation {
    pub project_id: u64,
    pub milestone_id: u64,
    pub deliverable_digest: String,
    pub receipt_id: String,
    pub result: VerificationResult,
    pub verifier: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingTransfer {
    pub operation_id: u64,
    pub project_id: u64,
    pub milestone_id: Option<u64>,
    pub amount: u128,
    pub recipient: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Milestone {
    pub milestone_id: u64,
    pub recipient: AccountId,
    pub budget: u128,
    pub dependencies: Vec<u64>,
    pub status: MilestoneStatus,
    pub verification: Option<VerificationAttestation>,
    pub approval_receipt_id: Option<String>,
}

#[near(serializers = [borsh])]
pub struct Project {
    pub project_id: u64,
    pub owner: AccountId,
    pub total_funded: u128,
    pub available_balance: u128,
    pub reserved_balance: u128,
    pub paid_balance: u128,
    pub refunded_balance: u128,
    pub pending_refund_balance: u128,
    pub next_milestone_id: u64,
    pub milestones: LookupMap<u64, Milestone>,
    pub pending_payment: Option<PendingTransfer>,
    pub pending_refund: Option<PendingTransfer>,
    pub storage_deposit: u128,
}

#[near(serializers = [json])]
pub struct ProjectView {
    pub project_id: u64,
    pub owner: AccountId,
    pub total_funded: U128,
    pub available_balance: U128,
    pub reserved_balance: U128,
    pub paid_balance: U128,
    pub refunded_balance: U128,
    pub pending_refund_balance: U128,
    pub next_milestone_id: u64,
    pub pending_payment: Option<u64>,
    pub pending_refund: Option<u64>,
    pub storage_deposit: U128,
}

#[near(serializers = [json])]
pub struct MilestoneView {
    pub project_id: u64,
    pub milestone_id: u64,
    pub recipient: AccountId,
    pub budget: U128,
    pub dependencies: Vec<u64>,
    pub status: MilestoneStatus,
    pub verification: Option<VerificationAttestation>,
    pub approval_receipt_id: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    administrator: AccountId,
    authorized_verifier: AccountId,
    storage_deposit: u128,
    next_project_id: u64,
    next_operation_id: u64,
    projects: IterableMap<u64, Project>,
    used_receipt_ids: IterableSet<String>,
}

#[near]
impl Escrow {
    #[init]
    #[payable]
    pub fn new(administrator: AccountId, verifier: AccountId) -> Self {
        assert!(!env::state_exists(), "Contract is already initialized");
        assert_eq!(
            env::predecessor_account_id(),
            administrator,
            "Administrator must be the initialization caller"
        );

        let before = env::storage_usage();
        let mut contract = Self {
            administrator,
            authorized_verifier: verifier,
            storage_deposit: 0,
            next_project_id: 0,
            next_operation_id: 0,
            projects: IterableMap::new(StorageKey::Projects),
            used_receipt_ids: IterableSet::new(StorageKey::UsedReceiptIds),
        };
        contract.flush_for_storage_measurement(None, false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        contract.storage_deposit = env::attached_deposit().as_yoctonear();
        env::state_write(&contract);
        contract
    }

    #[payable]
    pub fn set_authorized_verifier(&mut self, verifier: AccountId) {
        self.assert_administrator();
        let before = env::storage_usage();
        let previous = self.authorized_verifier.clone();
        self.authorized_verifier = verifier.clone();
        self.flush_for_storage_measurement(None, false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        self.storage_deposit = checked_add(
            self.storage_deposit,
            env::attached_deposit().as_yoctonear(),
            "Storage deposit overflow",
        );
        env::state_write(self);
        emit_event(
            "verifier_changed",
            serde_json::json!({
                "administrator": env::predecessor_account_id(),
                "previous_verifier": previous,
                "verifier": verifier,
            }),
        );
    }

    #[payable]
    pub fn create_project(&mut self) -> u64 {
        let project_id = self.next_project_id;
        self.next_project_id = checked_increment(project_id, "Project ID exhausted");
        let owner = env::predecessor_account_id();
        let before = env::storage_usage();
        let project = Project {
            project_id,
            owner: owner.clone(),
            total_funded: 0,
            available_balance: 0,
            reserved_balance: 0,
            paid_balance: 0,
            refunded_balance: 0,
            pending_refund_balance: 0,
            next_milestone_id: 0,
            milestones: LookupMap::new(StorageKey::Milestones { project_id }),
            pending_payment: None,
            pending_refund: None,
            storage_deposit: 0,
        };
        let mut project = project;
        project.milestones.flush();
        self.projects.insert(project_id, project);
        self.flush_for_storage_measurement(None, false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        let storage_deposit = env::attached_deposit().as_yoctonear();
        self.projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during creation"))
            .storage_deposit = storage_deposit;
        self.flush_for_storage_measurement(Some(project_id), false);

        emit_event(
            "project_created",
            serde_json::json!({
                "project_id": project_id,
                "owner": owner,
                "storage_deposit": storage_deposit.to_string(),
            }),
        );
        project_id
    }

    #[payable]
    pub fn fund_project(&mut self, project_id: u64) {
        let amount = env::attached_deposit().as_yoctonear();
        assert!(amount > 0, "Funding deposit must be positive");
        self.assert_project_owner(project_id);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        project.total_funded = checked_add(project.total_funded, amount, "Funding overflow");
        project.available_balance = checked_add(
            project.available_balance,
            amount,
            "Available balance overflow",
        );
        emit_event(
            "project_funded",
            serde_json::json!({
                "project_id": project_id,
                "owner": env::predecessor_account_id(),
                "amount": amount.to_string(),
            }),
        );
    }

    #[payable]
    pub fn register_milestone(
        &mut self,
        project_id: u64,
        recipient: AccountId,
        budget: U128,
        dependencies: Vec<u64>,
    ) -> u64 {
        require_bounded_length(recipient.as_str(), 64, "Recipient identifier is too long");
        assert!(budget.0 > 0, "Milestone budget must be positive");
        assert!(
            dependencies.len() <= MAX_DEPENDENCIES_PER_MILESTONE,
            "Too many milestone dependencies"
        );

        self.assert_project_owner(project_id);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        assert!(
            project.next_milestone_id < MAX_MILESTONES_PER_PROJECT,
            "Milestone limit reached"
        );
        let milestone_id = project.next_milestone_id;

        for (index, dependency_id) in dependencies.iter().enumerate() {
            assert!(
                *dependency_id < milestone_id,
                "Invalid milestone dependency"
            );
            assert!(
                project.milestones.get(dependency_id).is_some(),
                "Dependency milestone does not exist"
            );
            assert!(
                dependencies[..index]
                    .iter()
                    .all(|other| other != dependency_id),
                "Duplicate milestone dependency"
            );
        }

        let before = env::storage_usage();
        let milestone = Milestone {
            milestone_id,
            recipient: recipient.clone(),
            budget: budget.0,
            dependencies: dependencies.clone(),
            status: MilestoneStatus::Created,
            verification: None,
            approval_receipt_id: None,
        };
        project.milestones.insert(milestone_id, milestone);
        project.next_milestone_id = checked_increment(milestone_id, "Milestone ID exhausted");
        project.milestones.flush();
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        let storage_deposit = env::attached_deposit().as_yoctonear();
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during milestone registration"));
        project.storage_deposit = checked_add(
            project.storage_deposit,
            storage_deposit,
            "Storage deposit overflow",
        );
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        emit_event(
            "milestone_registered",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "owner": env::predecessor_account_id(),
                "recipient": recipient,
                "budget": budget.0.to_string(),
                "dependencies": dependencies,
            }),
        );
        milestone_id
    }

    #[payable]
    pub fn activate_milestone(&mut self, project_id: u64, milestone_id: u64) {
        require_one_yocto();
        self.assert_project_owner(project_id);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert_eq!(
            milestone.status,
            MilestoneStatus::Created,
            "Milestone is not in Created state"
        );
        assert!(
            project.available_balance >= milestone.budget,
            "Insufficient available project funding"
        );
        project.available_balance = checked_sub(
            project.available_balance,
            milestone.budget,
            "Available balance underflow",
        );
        project.reserved_balance = checked_add(
            project.reserved_balance,
            milestone.budget,
            "Reserved balance overflow",
        );
        milestone.status = MilestoneStatus::Funded;
        project.milestones.insert(milestone_id, milestone.clone());

        emit_event(
            "milestone_funded",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "owner": env::predecessor_account_id(),
                "amount": milestone.budget.to_string(),
            }),
        );
    }

    #[payable]
    pub fn start_milestone(&mut self, project_id: u64, milestone_id: u64) {
        require_one_yocto();
        self.assert_project_owner(project_id);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        match milestone.status {
            MilestoneStatus::Funded => {}
            MilestoneStatus::VerificationFailed => {
                milestone.verification = None;
                milestone.approval_receipt_id = None;
            }
            _ => env::panic_str("Milestone cannot be started from its current state"),
        }
        milestone.status = MilestoneStatus::InProgress;
        project.milestones.insert(milestone_id, milestone);
        emit_event(
            "milestone_started",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "owner": env::predecessor_account_id(),
            }),
        );
    }

    #[payable]
    pub fn submit_verification(
        &mut self,
        project_id: u64,
        milestone_id: u64,
        deliverable_digest: String,
        receipt_id: String,
        result: VerificationResult,
    ) {
        let before = env::storage_usage();
        assert_eq!(
            env::predecessor_account_id(),
            self.authorized_verifier,
            "Only the authorized verifier may submit verification"
        );
        require_bounded_length(
            &deliverable_digest,
            MAX_DIGEST_LENGTH,
            "Deliverable digest is too long",
        );
        require_bounded_length(
            &receipt_id,
            MAX_RECEIPT_ID_LENGTH,
            "Verification receipt ID is too long",
        );
        assert!(
            !deliverable_digest.is_empty(),
            "Deliverable digest is required"
        );
        assert!(
            !receipt_id.is_empty(),
            "Verification receipt ID is required"
        );
        assert!(
            !self.used_receipt_ids.contains(&receipt_id),
            "Verification receipt ID has already been used"
        );

        let project = self
            .projects
            .get(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let milestone = project
            .milestones
            .get(&milestone_id)
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert_eq!(
            milestone.status,
            MilestoneStatus::InProgress,
            "Milestone is not in InProgress state"
        );
        self.used_receipt_ids.insert(receipt_id.clone());
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        milestone.verification = Some(VerificationAttestation {
            project_id,
            milestone_id,
            deliverable_digest: deliverable_digest.clone(),
            receipt_id: receipt_id.clone(),
            result,
            verifier: env::predecessor_account_id(),
        });
        milestone.approval_receipt_id = None;
        milestone.status = match result {
            VerificationResult::Passed => MilestoneStatus::VerificationPassed,
            VerificationResult::Failed => MilestoneStatus::VerificationFailed,
        };
        project.milestones.insert(milestone_id, milestone);
        project.milestones.flush();
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), true);
        let required = storage_cost_for_delta(before, env::storage_usage());
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during verification"));
        charge_verification_storage(project, required);
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), true);

        emit_event(
            "verification_submitted",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "receipt_id": receipt_id,
                "deliverable_digest": deliverable_digest,
                "result": result,
                "verifier": env::predecessor_account_id(),
            }),
        );
    }

    #[payable]
    pub fn approve_milestone(&mut self, project_id: u64, milestone_id: u64, receipt_id: String) {
        let before = env::storage_usage();
        self.assert_project_owner(project_id);
        require_bounded_length(
            &receipt_id,
            MAX_RECEIPT_ID_LENGTH,
            "Verification receipt ID is too long",
        );
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert_eq!(
            milestone.status,
            MilestoneStatus::VerificationPassed,
            "Milestone does not have a successful verification"
        );
        let verification = milestone
            .verification
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Successful verification is missing"));
        assert_eq!(verification.result, VerificationResult::Passed);
        assert_eq!(
            verification.receipt_id, receipt_id,
            "Approval receipt mismatch"
        );
        assert!(
            milestone.approval_receipt_id.is_none(),
            "Milestone is already approved"
        );
        milestone.approval_receipt_id = Some(receipt_id.clone());
        milestone.status = MilestoneStatus::OwnerApproved;
        project.milestones.insert(milestone_id, milestone);
        project.milestones.flush();
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during approval"));
        project.storage_deposit = checked_add(
            project.storage_deposit,
            env::attached_deposit().as_yoctonear(),
            "Storage deposit overflow",
        );
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);

        emit_event(
            "milestone_approved",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "receipt_id": receipt_id,
                "owner": env::predecessor_account_id(),
            }),
        );
    }

    #[payable]
    pub fn settle_milestone(&mut self, project_id: u64, milestone_id: u64) -> Promise {
        let before = env::storage_usage();
        self.assert_project_owner(project_id);
        assert!(
            self.next_operation_id < u64::MAX,
            "Transfer operation ID exhausted"
        );
        let operation_id = self.next_operation_id;
        self.next_operation_id = checked_increment(operation_id, "Transfer operation ID exhausted");

        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        assert!(
            project.pending_payment.is_none() && project.pending_refund.is_none(),
            "Another project transfer is pending"
        );
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert_eq!(
            milestone.status,
            MilestoneStatus::OwnerApproved,
            "Milestone is not owner approved"
        );
        let verification = milestone
            .verification
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Verification is missing"));
        assert_eq!(verification.result, VerificationResult::Passed);
        assert_eq!(
            verification.receipt_id.as_str(),
            milestone
                .approval_receipt_id
                .as_ref()
                .unwrap_or_else(|| env::panic_str("Owner approval is missing"))
                .as_str(),
            "Approval does not match latest verification"
        );
        for dependency_id in &milestone.dependencies {
            let dependency = project
                .milestones
                .get(dependency_id)
                .unwrap_or_else(|| env::panic_str("Dependency milestone does not exist"));
            assert_eq!(
                dependency.status,
                MilestoneStatus::Paid,
                "All milestone dependencies must be paid"
            );
        }
        assert!(
            project.reserved_balance >= milestone.budget,
            "Milestone budget is not fully reserved"
        );
        let recipient = milestone.recipient.clone();
        let amount = milestone.budget;
        project.pending_payment = Some(PendingTransfer {
            operation_id,
            project_id,
            milestone_id: Some(milestone_id),
            amount,
            recipient: recipient.clone(),
        });
        milestone.status = MilestoneStatus::PaymentPending;
        project.milestones.insert(milestone_id, milestone);
        project.milestones.flush();
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during settlement"));
        project.storage_deposit = checked_add(
            project.storage_deposit,
            env::attached_deposit().as_yoctonear(),
            "Storage deposit overflow",
        );
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);

        emit_event(
            "payment_pending",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "operation_id": operation_id,
                "amount": amount.to_string(),
                "recipient": recipient,
            }),
        );

        let callback_args = serde_json::to_vec(&serde_json::json!({
            "project_id": project_id,
            "milestone_id": milestone_id,
            "operation_id": operation_id,
            "amount": U128(amount),
            "recipient": recipient,
        }))
        .unwrap_or_else(|_| env::panic_str("Failed to serialize payment callback"));
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_payment_complete",
                callback_args,
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_payment_complete(
        &mut self,
        project_id: u64,
        milestone_id: u64,
        operation_id: u64,
        amount: U128,
        recipient: AccountId,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract callback may finalize payment"
        );
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected exactly one payment result"
        );
        let payment_succeeded = matches!(env::promise_result_checked(0, 1024), Ok(_));
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let pending = project
            .pending_payment
            .clone()
            .unwrap_or_else(|| env::panic_str("No pending payment exists"));
        assert_eq!(
            pending.operation_id, operation_id,
            "Payment operation mismatch"
        );
        assert_eq!(pending.project_id, project_id, "Payment project mismatch");
        assert_eq!(
            pending.milestone_id,
            Some(milestone_id),
            "Payment milestone mismatch"
        );
        assert_eq!(pending.amount, amount.0, "Payment amount mismatch");
        assert_eq!(pending.recipient, recipient, "Payment recipient mismatch");
        let milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert_eq!(milestone.status, MilestoneStatus::PaymentPending);
        project.pending_payment = None;
        let mut updated = milestone;
        if payment_succeeded {
            project.reserved_balance = checked_sub(
                project.reserved_balance,
                amount.0,
                "Reserved balance underflow",
            );
            project.paid_balance =
                checked_add(project.paid_balance, amount.0, "Paid balance overflow");
            updated.status = MilestoneStatus::Paid;
        } else {
            updated.status = MilestoneStatus::OwnerApproved;
        }
        project.milestones.insert(milestone_id, updated);
        emit_event(
            if payment_succeeded {
                "payment_succeeded"
            } else {
                "payment_failed"
            },
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "operation_id": operation_id,
                "amount": amount.0.to_string(),
                "recipient": recipient,
            }),
        );
    }

    #[payable]
    pub fn cancel_milestone(&mut self, project_id: u64, milestone_id: u64) {
        require_one_yocto();
        self.assert_project_owner(project_id);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        assert!(
            project.pending_payment.is_none() && project.pending_refund.is_none(),
            "Another project transfer is pending"
        );
        let mut milestone = project
            .milestones
            .get(&milestone_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Milestone does not exist"));
        assert!(
            !matches!(
                milestone.status,
                MilestoneStatus::OwnerApproved
                    | MilestoneStatus::PaymentPending
                    | MilestoneStatus::Paid
                    | MilestoneStatus::Cancelled
                    | MilestoneStatus::Refunded
            ),
            "Milestone cannot be cancelled from its current state"
        );
        for dependent_id in 0..project.next_milestone_id {
            let Some(dependent) = project.milestones.get(&dependent_id) else {
                continue;
            };
            if dependent.dependencies.contains(&milestone_id)
                && !matches!(
                    dependent.status,
                    MilestoneStatus::Paid | MilestoneStatus::Cancelled | MilestoneStatus::Refunded
                )
            {
                env::panic_str("Milestone has a nonterminal dependent");
            }
        }
        if matches!(
            milestone.status,
            MilestoneStatus::Funded
                | MilestoneStatus::InProgress
                | MilestoneStatus::VerificationFailed
                | MilestoneStatus::VerificationPassed
        ) {
            project.reserved_balance = checked_sub(
                project.reserved_balance,
                milestone.budget,
                "Reserved balance underflow",
            );
            project.available_balance = checked_add(
                project.available_balance,
                milestone.budget,
                "Available balance overflow",
            );
        }
        milestone.status = MilestoneStatus::Cancelled;
        project.milestones.insert(milestone_id, milestone);
        emit_event(
            "milestone_cancelled",
            serde_json::json!({
                "project_id": project_id,
                "milestone_id": milestone_id,
                "owner": env::predecessor_account_id(),
            }),
        );
    }

    #[payable]
    pub fn refund_project(&mut self, project_id: u64) -> Promise {
        let before = env::storage_usage();
        self.assert_project_owner(project_id);
        assert!(
            self.next_operation_id < u64::MAX,
            "Transfer operation ID exhausted"
        );
        let operation_id = self.next_operation_id;
        self.next_operation_id = checked_increment(operation_id, "Transfer operation ID exhausted");
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        assert!(
            project.pending_payment.is_none() && project.pending_refund.is_none(),
            "Another project transfer is pending"
        );
        let amount = project.available_balance;
        assert!(amount > 0, "No available project balance to refund");
        let owner = project.owner.clone();
        project.available_balance = checked_sub(
            project.available_balance,
            amount,
            "Available balance underflow",
        );
        project.pending_refund_balance = checked_add(
            project.pending_refund_balance,
            amount,
            "Pending refund balance overflow",
        );
        project.pending_refund = Some(PendingTransfer {
            operation_id,
            project_id,
            milestone_id: None,
            amount,
            recipient: owner.clone(),
        });
        project.milestones.flush();
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        let required = storage_cost_for_delta(before, env::storage_usage());
        assert_storage_deposit_is_sufficient(required);
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project disappeared during refund"));
        project.storage_deposit = checked_add(
            project.storage_deposit,
            env::attached_deposit().as_yoctonear(),
            "Storage deposit overflow",
        );
        let _ = project;
        self.flush_for_storage_measurement(Some(project_id), false);
        emit_event(
            "refund_pending",
            serde_json::json!({
                "project_id": project_id,
                "operation_id": operation_id,
                "amount": amount.to_string(),
                "recipient": owner,
            }),
        );

        let callback_args = serde_json::to_vec(&serde_json::json!({
            "project_id": project_id,
            "operation_id": operation_id,
            "amount": U128(amount),
            "recipient": owner,
        }))
        .unwrap_or_else(|_| env::panic_str("Failed to serialize refund callback"));
        Promise::new(owner)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_refund_complete",
                callback_args,
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_refund_complete(
        &mut self,
        project_id: u64,
        operation_id: u64,
        amount: U128,
        recipient: AccountId,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the contract callback may finalize refund"
        );
        assert_eq!(
            env::promise_results_count(),
            1,
            "Expected exactly one refund result"
        );
        let refund_succeeded = matches!(env::promise_result_checked(0, 1024), Ok(_));
        let project = self
            .projects
            .get_mut(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        let pending = project
            .pending_refund
            .clone()
            .unwrap_or_else(|| env::panic_str("No pending refund exists"));
        assert_eq!(
            pending.operation_id, operation_id,
            "Refund operation mismatch"
        );
        assert_eq!(pending.project_id, project_id, "Refund project mismatch");
        assert_eq!(pending.milestone_id, None, "Refund milestone mismatch");
        assert_eq!(pending.amount, amount.0, "Refund amount mismatch");
        assert_eq!(pending.recipient, recipient, "Refund recipient mismatch");
        project.pending_refund = None;
        project.pending_refund_balance = checked_sub(
            project.pending_refund_balance,
            amount.0,
            "Pending refund balance underflow",
        );
        if refund_succeeded {
            project.refunded_balance = checked_add(
                project.refunded_balance,
                amount.0,
                "Refunded balance overflow",
            );
        } else {
            project.available_balance = checked_add(
                project.available_balance,
                amount.0,
                "Available balance overflow",
            );
        }
        emit_event(
            if refund_succeeded {
                "refund_succeeded"
            } else {
                "refund_failed"
            },
            serde_json::json!({
                "project_id": project_id,
                "operation_id": operation_id,
                "amount": amount.0.to_string(),
                "recipient": recipient,
            }),
        );
    }

    pub fn get_project(&self, project_id: u64) -> Option<ProjectView> {
        self.projects.get(&project_id).map(|project| ProjectView {
            project_id: project.project_id,
            owner: project.owner.clone(),
            total_funded: U128(project.total_funded),
            available_balance: U128(project.available_balance),
            reserved_balance: U128(project.reserved_balance),
            paid_balance: U128(project.paid_balance),
            refunded_balance: U128(project.refunded_balance),
            pending_refund_balance: U128(project.pending_refund_balance),
            next_milestone_id: project.next_milestone_id,
            pending_payment: project
                .pending_payment
                .as_ref()
                .map(|pending| pending.operation_id),
            pending_refund: project
                .pending_refund
                .as_ref()
                .map(|pending| pending.operation_id),
            storage_deposit: U128(project.storage_deposit),
        })
    }

    pub fn get_milestone(&self, project_id: u64, milestone_id: u64) -> Option<MilestoneView> {
        self.projects.get(&project_id).and_then(|project| {
            project
                .milestones
                .get(&milestone_id)
                .map(|milestone| MilestoneView {
                    project_id,
                    milestone_id: milestone.milestone_id,
                    recipient: milestone.recipient.clone(),
                    budget: U128(milestone.budget),
                    dependencies: milestone.dependencies.clone(),
                    status: milestone.status,
                    verification: milestone.verification.clone(),
                    approval_receipt_id: milestone.approval_receipt_id.clone(),
                })
        })
    }

    pub fn get_project_ids(&self, owner: AccountId, from_index: u64, limit: u64) -> Vec<u64> {
        let limit = limit.min(MAX_PROJECT_PAGE_SIZE);
        self.projects
            .iter()
            .filter(|(_, project)| project.owner == owner)
            .map(|(project_id, _)| *project_id)
            .skip(from_index as usize)
            .take(limit as usize)
            .collect()
    }
}

impl Escrow {
    /// `near_sdk::store` collections cache writes. Flush the touched nested
    /// collection and the top-level collections before measuring or writing
    /// state, otherwise `env::storage_usage()` under-reports persistent growth.
    fn flush_for_storage_measurement(&mut self, project_id: Option<u64>, receipts: bool) {
        if let Some(project_id) = project_id {
            self.projects
                .get_mut(&project_id)
                .unwrap_or_else(|| env::panic_str("Project disappeared during storage flush"))
                .milestones
                .flush();
        }
        self.projects.flush();
        if receipts {
            self.used_receipt_ids.flush();
        }
        env::state_write(self);
    }

    fn assert_administrator(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.administrator,
            "Only the administrator may perform this action"
        );
    }

    fn assert_owner(&self, project: &Project) {
        assert_eq!(
            env::predecessor_account_id(),
            project.owner,
            "Only the project owner may perform this action"
        );
    }

    fn assert_project_owner(&self, project_id: u64) {
        let project = self
            .projects
            .get(&project_id)
            .unwrap_or_else(|| env::panic_str("Project does not exist"));
        self.assert_owner(project);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, VMContext};

    fn context(predecessor: AccountId, deposit: u128) -> VMContext {
        VMContextBuilder::new()
            .current_account_id(accounts(0))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build()
    }

    fn set_promise_result(context: VMContext, result: PromiseResult) {
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            vec![result],
        );
    }

    fn init() -> Escrow {
        testing_env!(context(accounts(0), 10u128.pow(24)));
        Escrow::new(accounts(0), accounts(1))
    }

    fn create_project(contract: &mut Escrow) -> u64 {
        testing_env!(context(accounts(2), 10u128.pow(24)));
        contract.create_project()
    }

    fn prepare_in_progress(contract: &mut Escrow, budget: u128) -> (u64, u64) {
        let project_id = create_project(contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let milestone_id =
            contract.register_milestone(project_id, accounts(4), U128(budget), vec![]);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, milestone_id);
        contract.start_milestone(project_id, milestone_id);
        (project_id, milestone_id)
    }

    fn submit(
        contract: &mut Escrow,
        project_id: u64,
        milestone_id: u64,
        receipt_id: &str,
        result: VerificationResult,
    ) {
        testing_env!(context(accounts(1), 10u128.pow(24)));
        contract.submit_verification(
            project_id,
            milestone_id,
            format!("digest-{receipt_id}"),
            receipt_id.to_string(),
            result,
        );
    }

    fn approve(contract: &mut Escrow, project_id: u64, milestone_id: u64, receipt_id: &str) {
        testing_env!(context(accounts(2), 10u128.pow(24)));
        contract.approve_milestone(project_id, milestone_id, receipt_id.to_string());
    }

    fn callback_success(
        contract: &mut Escrow,
        project_id: u64,
        milestone_id: u64,
        operation_id: u64,
        amount: u128,
        recipient: AccountId,
    ) {
        set_promise_result(context(accounts(0), 0), PromiseResult::Successful(vec![]));
        contract.on_payment_complete(
            project_id,
            milestone_id,
            operation_id,
            U128(amount),
            recipient,
        );
    }

    fn callback_failed(
        contract: &mut Escrow,
        project_id: u64,
        milestone_id: u64,
        operation_id: u64,
        amount: u128,
        recipient: AccountId,
    ) {
        set_promise_result(context(accounts(0), 0), PromiseResult::Failed);
        contract.on_payment_complete(
            project_id,
            milestone_id,
            operation_id,
            U128(amount),
            recipient,
        );
    }

    #[test]
    fn initializes_with_explicit_admin_and_verifier() {
        let contract = init();
        assert_eq!(contract.administrator, accounts(0));
        assert_eq!(contract.authorized_verifier, accounts(1));
        assert_eq!(contract.next_project_id, 0);
    }

    #[test]
    fn project_ids_are_sequential_and_owner_is_predecessor() {
        let mut contract = init();
        let first = create_project(&mut contract);
        let second = create_project(&mut contract);
        assert_eq!((first, second), (0, 1));
        assert_eq!(contract.get_project(first).unwrap().owner, accounts(2));
    }

    #[test]
    #[should_panic(expected = "Only the project owner")]
    fn unauthorized_project_funding_is_rejected() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(3), 5));
        contract.fund_project(project_id);
    }

    #[test]
    #[should_panic(expected = "Funding deposit must be positive")]
    fn zero_value_funding_is_rejected() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 0));
        contract.fund_project(project_id);
    }

    #[test]
    fn invalid_recipient_is_rejected_before_contract_entry() {
        assert!(AccountId::try_from("not a valid account").is_err());
    }

    #[test]
    fn registers_milestones_with_sequential_ids() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let first = contract.register_milestone(project_id, accounts(4), U128(10), vec![]);
        let second = contract.register_milestone(project_id, accounts(5), U128(20), vec![first]);
        assert_eq!((first, second), (0, 1));
        assert_eq!(
            contract
                .get_milestone(project_id, second)
                .unwrap()
                .dependencies,
            vec![first]
        );
    }

    #[test]
    #[should_panic(expected = "Invalid milestone dependency")]
    fn rejects_self_or_future_dependencies() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        contract.register_milestone(project_id, accounts(4), U128(10), vec![0]);
    }

    #[test]
    #[should_panic(expected = "Invalid milestone dependency")]
    fn rejects_missing_dependencies() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        contract.register_milestone(project_id, accounts(4), U128(10), vec![7]);
    }

    #[test]
    #[should_panic(expected = "Insufficient available project funding")]
    fn activation_requires_sufficient_available_funding() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let milestone_id = contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, milestone_id);
    }

    #[test]
    fn activation_moves_exact_budget_to_reserved_balance() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let milestone_id = contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, milestone_id);
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.total_funded.0, 1_000);
        assert_eq!(project.available_balance.0, 900);
        assert_eq!(project.reserved_balance.0, 100);
    }

    #[test]
    #[should_panic(expected = "Milestone is not in Created state")]
    fn activation_cannot_be_repeated() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let milestone_id = contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, milestone_id);
        contract.activate_milestone(project_id, milestone_id);
    }

    #[test]
    fn storage_deposit_is_separate_from_project_funding() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        let before = contract.get_project(project_id).unwrap();
        assert_eq!(before.total_funded.0, 0);
        assert!(before.storage_deposit.0 > 0);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        let after = contract.get_project(project_id).unwrap();
        assert_eq!(after.total_funded.0, 1_000);
        assert_eq!(after.storage_deposit.0, before.storage_deposit.0);
    }

    #[test]
    fn verification_storage_deposit_is_not_project_funding() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        let before = contract.get_project(project_id).unwrap();
        testing_env!(context(accounts(1), 10u128.pow(24)));
        contract.submit_verification(
            project_id,
            milestone_id,
            "digest-storage".to_string(),
            "receipt-storage".to_string(),
            VerificationResult::Passed,
        );
        let after = contract.get_project(project_id).unwrap();
        assert_eq!(after.total_funded.0, before.total_funded.0);
        assert_eq!(after.available_balance.0, before.available_balance.0);
        assert_eq!(after.reserved_balance.0, before.reserved_balance.0);
        assert_eq!(
            after.storage_deposit.0,
            before.storage_deposit.0 + 10u128.pow(24)
        );
    }

    #[test]
    fn zero_deposit_verification_charges_existing_project_storage_credit() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        let before = contract.get_project(project_id).unwrap();
        testing_env!(context(accounts(1), 0));
        contract.submit_verification(
            project_id,
            milestone_id,
            "digest-zero-deposit".to_string(),
            "receipt-zero-deposit".to_string(),
            VerificationResult::Passed,
        );
        let after = contract.get_project(project_id).unwrap();
        assert!(after.storage_deposit.0 < before.storage_deposit.0);
        assert_eq!(after.total_funded.0, before.total_funded.0);
        assert_eq!(after.reserved_balance.0, before.reserved_balance.0);
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::VerificationPassed
        );
    }

    #[test]
    #[should_panic(expected = "Insufficient project storage credit")]
    fn zero_deposit_verification_requires_existing_storage_credit() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        contract
            .projects
            .get_mut(&project_id)
            .unwrap()
            .storage_deposit = 0;
        testing_env!(context(accounts(1), 0));
        contract.submit_verification(
            project_id,
            milestone_id,
            "digest-no-credit".to_string(),
            "receipt-no-credit".to_string(),
            VerificationResult::Passed,
        );
    }

    #[test]
    #[should_panic(expected = "Insufficient storage deposit")]
    fn flushed_storage_growth_cannot_be_underfunded() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 1));
        contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
    }

    #[test]
    fn measures_max_shape_project_storage_growth() {
        let mut contract = init();
        let owner = AccountId::try_from("a".repeat(64)).unwrap();
        let before = env::storage_usage();
        testing_env!(context(owner, 10u128.pow(24)));
        contract.create_project();
        let after = env::storage_usage();
        let bytes = after - before;
        println!(
            "STORAGE_MEASUREMENT project bytes={bytes} byte_cost={} yocto={}",
            env::storage_byte_cost().as_yoctonear(),
            bytes as u128 * env::storage_byte_cost().as_yoctonear()
        );
        assert!(bytes > 0);
    }

    #[test]
    fn measures_max_shape_milestone_storage_growth() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        let recipient = AccountId::try_from("b".repeat(64)).unwrap();
        let dependencies = (0..32).collect::<Vec<_>>();

        // Establish the dependency records first, then measure the largest
        // permitted milestone payload against the already-grown collections.
        for _ in 0..32 {
            testing_env!(context(accounts(2), 10u128.pow(24)));
            contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        }

        testing_env!(context(accounts(2), 10u128.pow(24)));
        let before = env::storage_usage();
        contract.register_milestone(project_id, recipient, U128(100), dependencies);
        let after = env::storage_usage();
        let bytes = after - before;
        println!(
            "STORAGE_MEASUREMENT milestone bytes={bytes} byte_cost={} yocto={}",
            env::storage_byte_cost().as_yoctonear(),
            bytes as u128 * env::storage_byte_cost().as_yoctonear()
        );
        assert!(bytes > 0);
    }

    #[test]
    #[should_panic(expected = "Funding overflow")]
    fn funding_arithmetic_is_checked() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        let project = contract.projects.get_mut(&project_id).unwrap();
        project.total_funded = u128::MAX;
        testing_env!(context(accounts(2), 1));
        contract.fund_project(project_id);
    }

    #[test]
    #[should_panic(expected = "Only the administrator")]
    fn verifier_rotation_requires_administrator() {
        let mut contract = init();
        testing_env!(context(accounts(2), 1));
        contract.set_authorized_verifier(accounts(3));
    }

    #[test]
    fn administrator_can_rotate_verifier() {
        let mut contract = init();
        testing_env!(context(accounts(0), 10u128.pow(24)));
        contract.set_authorized_verifier(accounts(3));
        assert_eq!(contract.authorized_verifier, accounts(3));
    }

    #[test]
    #[should_panic(expected = "Only the authorized verifier")]
    fn unauthorized_verifier_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        testing_env!(context(accounts(3), 1));
        contract.submit_verification(
            project_id,
            milestone_id,
            "digest".to_string(),
            "receipt".to_string(),
            VerificationResult::Passed,
        );
    }

    #[test]
    fn successful_verification_is_stored_without_approval() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "receipt-success",
            VerificationResult::Passed,
        );
        let milestone = contract.get_milestone(project_id, milestone_id).unwrap();
        assert_eq!(milestone.status, MilestoneStatus::VerificationPassed);
        assert_eq!(milestone.approval_receipt_id, None);
        assert_eq!(milestone.verification.unwrap().verifier, accounts(1));
    }

    #[test]
    fn failed_verification_cannot_authorize_payment() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "receipt-failed",
            VerificationResult::Failed,
        );
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::VerificationFailed
        );
    }

    #[test]
    #[should_panic(expected = "already been used")]
    fn duplicate_receipt_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "receipt-duplicate",
            VerificationResult::Passed,
        );
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "receipt-duplicate",
            VerificationResult::Passed,
        );
    }

    #[test]
    #[should_panic(expected = "already been used")]
    fn receipt_reuse_across_projects_is_rejected() {
        let mut contract = init();
        let (first_project, first_milestone) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            first_project,
            first_milestone,
            "global-receipt",
            VerificationResult::Passed,
        );
        let (second_project, second_milestone) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            second_project,
            second_milestone,
            "global-receipt",
            VerificationResult::Passed,
        );
    }

    #[test]
    fn owner_approval_binds_to_successful_receipt() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "approval-receipt",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "approval-receipt");
        let milestone = contract.get_milestone(project_id, milestone_id).unwrap();
        assert_eq!(milestone.status, MilestoneStatus::OwnerApproved);
        assert_eq!(
            milestone.approval_receipt_id,
            Some("approval-receipt".to_string())
        );
    }

    #[test]
    #[should_panic(expected = "Only the project owner")]
    fn unauthorized_owner_approval_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "owner-receipt",
            VerificationResult::Passed,
        );
        testing_env!(context(accounts(3), 1));
        contract.approve_milestone(project_id, milestone_id, "owner-receipt".to_string());
    }

    #[test]
    #[should_panic(expected = "Approval receipt mismatch")]
    fn incorrect_approval_receipt_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "actual-receipt",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "wrong-receipt");
    }

    #[test]
    fn failed_verification_requires_explicit_rework_and_new_receipt() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "failed-receipt",
            VerificationResult::Failed,
        );
        testing_env!(context(accounts(2), 1));
        contract.start_milestone(project_id, milestone_id);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "rework-receipt",
            VerificationResult::Passed,
        );
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .verification
                .unwrap()
                .receipt_id,
            "rework-receipt"
        );
    }

    #[test]
    #[should_panic(expected = "Milestone is not owner approved")]
    fn settlement_without_verification_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
    }

    #[test]
    #[should_panic(expected = "Milestone is not owner approved")]
    fn settlement_without_owner_approval_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "unapproved-receipt",
            VerificationResult::Passed,
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
    }

    #[test]
    #[should_panic(expected = "All milestone dependencies must be paid")]
    fn settlement_requires_paid_dependencies() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let dependency = contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        let dependent =
            contract.register_milestone(project_id, accounts(5), U128(100), vec![dependency]);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, dependency);
        contract.activate_milestone(project_id, dependent);
        contract.start_milestone(project_id, dependent);
        submit(
            &mut contract,
            project_id,
            dependent,
            "dependent-receipt",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, dependent, "dependent-receipt");
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, dependent);
    }

    #[test]
    #[should_panic(expected = "Another project transfer is pending")]
    fn double_settlement_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "settlement-receipt",
            VerificationResult::Passed,
        );
        approve(
            &mut contract,
            project_id,
            milestone_id,
            "settlement-receipt",
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        let _ = contract.settle_milestone(project_id, milestone_id);
    }

    #[test]
    fn settlement_persists_exact_pending_transfer() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "pending-receipt",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "pending-receipt");
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        let project = contract.projects.get(&project_id).unwrap();
        let pending = project.pending_payment.as_ref().unwrap();
        assert_eq!(pending.amount, 100);
        assert_eq!(pending.milestone_id, Some(milestone_id));
        assert_eq!(pending.recipient, accounts(4));
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::PaymentPending
        );
    }

    #[test]
    fn successful_payment_callback_moves_reserved_to_paid() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "success-payment",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "success-payment");
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        callback_success(&mut contract, project_id, milestone_id, 0, 100, accounts(4));
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.reserved_balance.0, 0);
        assert_eq!(project.paid_balance.0, 100);
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::Paid
        );
    }

    #[test]
    fn failed_payment_callback_preserves_reservation_for_retry() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "failed-payment",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "failed-payment");
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        callback_failed(&mut contract, project_id, milestone_id, 0, 100, accounts(4));
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.reserved_balance.0, 100);
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::OwnerApproved
        );
    }

    #[test]
    fn payment_retry_is_allowed_only_after_failure_callback() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "retry-payment",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "retry-payment");
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        callback_failed(&mut contract, project_id, milestone_id, 0, 100, accounts(4));
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        assert!(contract
            .projects
            .get(&project_id)
            .unwrap()
            .pending_payment
            .is_some());
    }

    #[test]
    #[should_panic(expected = "Only the contract callback")]
    fn unauthorized_payment_callback_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "unauthorized-callback",
            VerificationResult::Passed,
        );
        approve(
            &mut contract,
            project_id,
            milestone_id,
            "unauthorized-callback",
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        set_promise_result(context(accounts(3), 0), PromiseResult::Successful(vec![]));
        contract.on_payment_complete(project_id, milestone_id, 0, U128(100), accounts(4));
    }

    #[test]
    fn duplicate_payment_callback_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "duplicate-callback",
            VerificationResult::Passed,
        );
        approve(
            &mut contract,
            project_id,
            milestone_id,
            "duplicate-callback",
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        callback_success(&mut contract, project_id, milestone_id, 0, 100, accounts(4));
        set_promise_result(context(accounts(0), 0), PromiseResult::Successful(vec![]));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_payment_complete(project_id, milestone_id, 0, U128(100), accounts(4));
        }));
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "Milestone cannot be cancelled")]
    fn cancellation_after_approval_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "cancel-approved",
            VerificationResult::Passed,
        );
        approve(&mut contract, project_id, milestone_id, "cancel-approved");
        testing_env!(context(accounts(2), 1));
        contract.cancel_milestone(project_id, milestone_id);
    }

    #[test]
    #[should_panic(expected = "nonterminal dependent")]
    fn cancellation_with_dependent_milestone_is_rejected() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let dependency = contract.register_milestone(project_id, accounts(4), U128(100), vec![]);
        let _dependent =
            contract.register_milestone(project_id, accounts(5), U128(100), vec![dependency]);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 1));
        contract.activate_milestone(project_id, dependency);
        contract.cancel_milestone(project_id, dependency);
    }

    #[test]
    fn cancellation_releases_reserved_budget_exactly_once() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        testing_env!(context(accounts(2), 1));
        contract.cancel_milestone(project_id, milestone_id);
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.available_balance.0, 1_000);
        assert_eq!(project.reserved_balance.0, 0);
        assert_eq!(
            contract
                .get_milestone(project_id, milestone_id)
                .unwrap()
                .status,
            MilestoneStatus::Cancelled
        );
    }

    #[test]
    fn refund_available_balance_and_success_callback_update_accounting() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.refund_project(project_id);
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.available_balance.0, 0);
        assert_eq!(project.pending_refund_balance.0, 1_000);
        set_promise_result(context(accounts(0), 0), PromiseResult::Successful(vec![]));
        contract.on_refund_complete(project_id, 0, U128(1_000), accounts(2));
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.pending_refund_balance.0, 0);
        assert_eq!(project.refunded_balance.0, 1_000);
    }

    #[test]
    #[should_panic(expected = "Another project transfer is pending")]
    fn refund_while_payment_is_pending_is_rejected() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "refund-pending-payment",
            VerificationResult::Passed,
        );
        approve(
            &mut contract,
            project_id,
            milestone_id,
            "refund-pending-payment",
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        let _ = contract.refund_project(project_id);
    }

    #[test]
    fn failed_refund_callback_restores_available_balance() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.refund_project(project_id);
        set_promise_result(context(accounts(0), 0), PromiseResult::Failed);
        contract.on_refund_complete(project_id, 0, U128(1_000), accounts(2));
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.available_balance.0, 1_000);
        assert_eq!(project.pending_refund_balance.0, 0);
    }

    #[test]
    fn duplicate_refund_callback_is_rejected() {
        let mut contract = init();
        let project_id = create_project(&mut contract);
        testing_env!(context(accounts(2), 1_000));
        contract.fund_project(project_id);
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.refund_project(project_id);
        set_promise_result(context(accounts(0), 0), PromiseResult::Successful(vec![]));
        contract.on_refund_complete(project_id, 0, U128(1_000), accounts(2));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_refund_complete(project_id, 0, U128(1_000), accounts(2));
        }));
        assert!(result.is_err());
    }

    #[test]
    fn accounting_invariant_holds_across_funding_reservation_payment_and_refund() {
        let mut contract = init();
        let (project_id, milestone_id) = prepare_in_progress(&mut contract, 100);
        submit(
            &mut contract,
            project_id,
            milestone_id,
            "accounting-receipt",
            VerificationResult::Passed,
        );
        approve(
            &mut contract,
            project_id,
            milestone_id,
            "accounting-receipt",
        );
        testing_env!(context(accounts(2), 10u128.pow(24)));
        let _ = contract.settle_milestone(project_id, milestone_id);
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(
            project.total_funded.0,
            project.available_balance.0
                + project.reserved_balance.0
                + project.paid_balance.0
                + project.refunded_balance.0
                + project.pending_refund_balance.0
        );
        callback_success(&mut contract, project_id, milestone_id, 0, 100, accounts(4));
        let project = contract.get_project(project_id).unwrap();
        assert_eq!(project.total_funded.0, 1_000);
        assert_eq!(project.paid_balance.0, 100);
        assert_eq!(project.storage_deposit.0, 5 * 10u128.pow(24));
    }
}
