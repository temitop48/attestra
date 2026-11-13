# ATTESTRA MVP scope

## Mandatory capabilities

The hackathon MVP must allow a user to:

1. Create a project through a structured form.
2. Define tasks, budgets, deadlines, dependencies, and deliverables.
3. Review and approve an AI-generated milestone plan.
4. Select specialized Research, Builder, and QA agents.
5. Fund project milestones using NEAR Testnet.
6. Monitor autonomous agent execution and task state.
7. Submit and inspect deliverable evidence.
8. Verify a completed deliverable against its milestone.
9. Release a milestone payment only after authorized verification.
10. Receive notifications for pending and completed tasks.

## Security acceptance conditions

- Agents never control user private keys.
- Contract state enforces project budgets and milestone amounts.
- Payment requires authorized verification.
- A milestone cannot be paid twice.
- A task cannot execute before its dependencies are complete.
- Verification results are linked to the correct project and milestone.
- Financial operations have an auditable event trail.

## Out of scope for Phase 1B

No AI orchestration, genuine worker execution, wallet connection, contract deployment, escrow logic, payment release, production authentication, or complete dashboard is included in the foundation phase. The starter frontend intentionally confirms only that the application is running.
