import * as core from '@actions/core';
import * as github from '@actions/github';
import * as Octokit from '@octokit/rest';
import {
    type IssueLabel

= Octokit.IssuesListForRepoResponseItemLabelsItem;
wasLastUpdatedBefore,
    appliedLabelBefore,
    isLabeled,
    parseLabels,
    isTrue,
    getDateOfLastAppliedStaleLabel,
}
from
"./utils"

type Issue = Octokit.IssuesListForRepoResponseItem;
type IssueLabel = Octokit.IssuesListForRepoResponseItemLabelsItem;

type Args = {
    repoToken: string;
    DRY_RUN: boolean;
    staleIssueMessage: string;
    stalePrMessage: string;
    daysBeforeStale: number;
    daysBeforeClose: number;
    staleIssueLabel: string;
    exemptIssueLabel: string;
    stalePrLabel: string;
    exemptPrLabel: string;
    operationsPerRun: number;
};

async function run() {
    try {
        const args = getAndValidateArgs();

        if (args.DRY_RUN) {
            core.debug(`----- Running in DRY mode -----`)
        }

        const client = new github.GitHub(args.repoToken);
        await processIssues(client, args, args.operationsPerRun);
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

async function processIssues(
    client: github.GitHub,
    args: Args,
    operationsLeft: number,
    page: number = 1
): Promise<number> {
    const issues = await client.issues.listForRepo({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        state: 'open',
        per_page: 100,
        page: page
    });

    operationsLeft -= 1;

    if (issues.data.length === 0 || operationsLeft === 0) {
        return operationsLeft;
    }

    for (var issue of issues.data.values()) {
        core.debug(`found issue: ${issue.title} last updated ${issue.updated_at}`);
        let isPr = !!issue.pull_request;

        let staleMessage = isPr ? args.stalePrMessage : args.staleIssueMessage;
        if (!staleMessage) {
            core.debug(`skipping ${isPr ? 'pr' : 'issue'} due to empty message`);
            continue;
        }

        let staleLabel = isPr ? args.stalePrLabel : args.staleIssueLabel;
        let exemptLabel = isPr ? args.exemptPrLabel : args.exemptIssueLabel;

        if (exemptLabel && isLabeled(issue, exemptLabel)) {
            continue;
        } else if (isLabeled(issue, staleLabel)) {
            // Check all events on the issue and get the date of the latest stale label application
            const dateOfStaleLabelApplication = await getDateOfLastAppliedStaleLabel(
                client,
                issue,
                staleLabel
            )
            // getDateOfLastAppliedStaleLabel might make more than 1 operation
            operationsLeft -= 1

            // Check if a user commented since that stale label application
            const wasThereUserActivitySinceThat = await issueHasActivitySinceStaleLabelWasApplied(
                client,
                issue,
                dateOfStaleLabelApplication
            )
            operationsLeft -= 1

            // When there was no activity on the issue and the stale label application is longer than the close days, close the issue
            if (
                !wasThereUserActivitySinceThat &&
                appliedLabelBefore(dateOfStaleLabelApplication, args.daysBeforeClose)
            ) {
                operationsLeft -= await closeIssue(
                    client,
                    issue,
                    args.stalePrMessage,
                    args.DRY_RUN
                )
                // If there was activity, remove the stale label
            } else if (wasThereUserActivitySinceThat) {
                operationsLeft -= await removeStaleLabel(
                    client,
                    issue,
                    staleLabel,
                    args.DRY_RUN
                )
            }
        } else if (wasLastUpdatedBefore(issue, args.daysBeforeStale)) {
            operationsLeft -= await addStaleLabel(
                client,
                issue,
                staleMessage,
                staleLabel,
                args.DRY_RUN
            );
        }

        if (operationsLeft <= 0) {
            core.warning(
                `performed ${args.operationsPerRun} operations, exiting to avoid rate limit`
            );
            return 0;
        }
    }
    return await processIssues(client, args, operationsLeft, page + 1);
}

async function issueHasActivitySinceStaleLabelWasApplied(
    client: github.GitHub,
    issue: Issue,
    staleLabelAppliedData: string
): Promise<boolean> {
    // Should also work for PRs since GitHub internally treats PRs like "issues"
    const comments = await client.issues.listComments({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: issue.number,
        since: staleLabelAppliedData,
    })

    // GitHub's API gives back "User" or "Bot" for the type
    const filtered = comments.data.filter(comment => comment.user.type === "User")

    return filtered.length > 0
}

async function addStaleLabel(
    client: github.GitHub,
    issue: Issue,
    staleMessage: string,
    staleLabel: string,
    dryRun: boolean
): Promise<number> {
    core.debug(`marking issue${issue.title} as stale`);

    if (!dryRun) {
        await client.issues.createComment({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: issue.number,
            body: staleMessage
        });

        await client.issues.addLabels({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: issue.number,
            labels: [staleLabel]
        });

        return 2; // operations performed
    } else {
        return 0
    }
}

async function removeStaleLabel(
    client: github.GitHub,
    issue: Issue,
    staleLabel: string,
    dryRun: boolean
): Promise<number> {
    core.debug(
        `removing stale label on issue "${issue.title}" (#${issue.number})`
    )

    if (!dryRun) {
        await client.issues.removeLabel({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: issue.number,
            name: encodeURIComponent(staleLabel), // A label can have a "?" in the name
        })

        return 1
    } else {
        return 0
    }
}

async function closeIssue(
    client: github.GitHub,
    issue: Issue,
    closeMessage: string,
    dryRun: boolean
): Promise<number> {
    core.debug(`closing issue ${issue.title} for being stale`);

    if(!dryRun){
        await client.issues.createComment({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: issue.number,
            body: closeMessage,
        })

        await client.issues.update({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: issue.number,
            state: "closed",
        })

        return 2
    } else {
        return 0
    }
}

function getAndValidateArgs(): Args {
    const args = {
        repoToken: core.getInput('repo-token', {required: true}),
        DRY_RUN: isTrue(core.getInput("DRY_RUN")),
        staleIssueMessage: core.getInput('stale-issue-message'),
        stalePrMessage: core.getInput('stale-pr-message'),
        daysBeforeStale: parseInt(
            core.getInput('days-before-stale', {required: true})
        ),
        daysBeforeClose: parseInt(
            core.getInput('days-before-close', {required: true})
        ),
        staleIssueLabel: core.getInput('stale-issue-label', {required: true}),
        exemptIssueLabel: core.getInput('exempt-issue-label'),
        stalePrLabel: core.getInput('stale-pr-label', {required: true}),
        exemptPrLabel: core.getInput('exempt-pr-label'),
        operationsPerRun: parseInt(
            core.getInput('operations-per-run', {required: true})
        )
    };

    for (var numberInput of [
        'days-before-stale',
        'days-before-close',
        'operations-per-run'
    ]) {
        if (isNaN(parseInt(core.getInput(numberInput)))) {
            throw Error(`input ${numberInput} did not parse to a valid integer`);
        }
    }

    return args;
}

run();
