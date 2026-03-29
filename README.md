# AI Council Reviewer

An advanced, multi-agent AI code review system powered by Google Gemini. This GitHub Action orchestrates a "Council" of specialized AI agents to review pull requests, providing comprehensive feedback across security, performance, architecture, documentation, and governance.

## ✨ Key Features

- **Context-Aware Reviews:** The aggregator agent automatically fetches previous comments (from humans and bots) from the PR history to understand the ongoing discussion and adapt its review context.
- **Smart Issue Tracking & Categorization:** Utilizing an embedded, hidden HTML payload (`<!-- council-data:... -->`) on PR comments, the workflow tracks issues across commits. It classifies them as:
  - **New Issues:** Fresh problems identified in the current commit.
  - **Recurring Issues:** Previously flagged issues that were still detected (collapsed by default to reduce noise).
  - **Persistent Issues:** Issues from earlier reviews located in files that *haven't changed* in the latest commit, preventing them from being silently forgotten if the LLM skips them.
- **Auto-Fixing (Draft PRs & Labels):** An optional Auto-Fixer agent will attempt to resolve CRITICAL and HIGH severity issues and commit the code directly to your branch. By default, it is configured to trigger **only on Draft PRs** or when the PR has the **`auto-fix`** label. This ensures your active PRs don't receive unexpected commits.
- **Cross-Repository Context:** For organizations with multiple repositories, the Architect agent dynamically scans PR diffs for configured domain keywords. If found, it fetches and reads related architecture code and documentation from your other repositories to ensure cross-repo contracts aren't broken.
- **Smart Diff Filtering:** Automatically skips irrelevant files (lockfiles, minified JS, images, svgs) to save tokens and focus the AI on meaningful logic.
- **Parallel AI Execution:** The Orchestrator dynamically generates a matrix of required agents (Security, Performance, Docs, etc.) which are then executed simultaneously by GitHub Actions. This drastically reduces the total review time compared to sequential pipelines.
- **Idempotency & Rate Limiting Failsafes:**
  - Includes **automatic retries with exponential backoff** to handle transient API failures without crashing the workflow.
  - Will safely update the existing PR comment (using `PATCH`) if the summary changes, rather than spamming the thread.
  - Has a built-in cooldown timer (e.g., 30 minutes) to prevent infinite loops if bots trigger automated commits.
  - Includes circuit breakers and an automated fallback model (e.g., falls back to `gemini-flash-latest`) in case of prolonged rate-limiting or API instability.
  - Uses a "Guardrail" to skip reviewing commits authored by recognized bots (`Council-Bot`, `github-actions[bot]`).

## Architecture

The system uses a "Chain of Draft" methodology with multiple distinct agents:

1. **Orchestrator (Triage):** Analyzes the PR diff and decides which specialist agents are needed based on the types of files and code changed.
2. **Specialist Matrix:** The selected agents run in parallel to review the code from their specific perspectives:
   - 🛡️ **Security Agent:** Audits for vulnerabilities, auth checks, and safe data handling.
   - 🚀 **Performance Agent:** Identifies bottlenecks, N+1 queries, and excessive re-renders.
   - 🏛️ **Architect Agent:** Checks cross-repo boundaries, service contracts, and structural consistency.
   - 📝 **Docs Agent:** Verifies API usage, deprecations, and missing documentation.
   - ⚖️ **Governance Agent:** Ensures adherence to project rules and proposes new rules for emerging patterns.
   - 🤔 **Contrarian Agent:** Challenges implementation choices and suggests better alternatives.
   - 🛠️ **General Agent:** Checks for clean code, style, and correctness.
3. **Aggregator:** Synthesizes the individual reports into a single, cohesive, prioritized Markdown comment on the PR. It tracks "persistent" and "recurring" issues across commits using hidden HTML metadata.
4. **Auto-Fixer (Optional):** Automatically attempts to fix CRITICAL and HIGH severity issues. To prevent unexpected automated commits on active PRs, this job runs **only if the PR is in Draft mode** or if it has the **`auto-fix`** label applied. The agent drafts a fix, critiques its own fix against the project's rules, and then finalizes the commit to the branch.

## Getting Started

### Prerequisites

- A **Gemini API Key** (from Google AI Studio or Google Cloud Vertex AI) stored in your repository secrets as `GEMINI_API_KEY`.
- The default `GITHUB_TOKEN` must have write permissions for pull requests and contents.

### Installation

Copy the `.github` directory from this repository into your own project's root.

```yaml
# .github/workflows/ai-code-review.yml

name: AI Code Review (Council of Agents)

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

# ... existing action code ...
```

### Configuration

The action is highly customizable via Environment Variables in the workflow file. Update these to match your project's context:

```yaml
env:
  # Base Configuration for the Council of Agents
  COUNCIL_PROJECT_NAME: "My Awesome Project"
  COUNCIL_PROJECT_DESC: "A SaaS platform for developers."
  COUNCIL_TECH_STACK: "Next.js, TypeScript, PostgreSQL, Tailwind CSS"
  COUNCIL_DOMAIN_KEYWORDS: "database, api, webhook, internal, auth, users"
  COUNCIL_ARCHITECTURE_DOCS: "README.md, docs/architecture.md"
  
  # Cross-Repository Context (Architect Agent)
  # Leave empty if you don't need cross-repo analysis
  COUNCIL_CROSS_REPO_1: "my-org/backend-service"
  COUNCIL_CROSS_REPO_2: "my-org/infrastructure"
  
  # API Route Parameterization
  # Change this to match your backend framework's route prefix (e.g., "/v1/", "/graphql", "/api/")
  COUNCIL_API_ROUTE_PREFIX: "/api/"
  
  # LLM Models Configuration
  COUNCIL_MAIN_MODEL: "gemini-3.1-pro-preview"
  COUNCIL_FALLBACK_MODEL: "gemini-flash-latest"
  
  # Failsafe and Constraints
  COUNCIL_REVIEW_COOLDOWN_MINUTES: "30"
```

- `COUNCIL_PROJECT_NAME`: The name of your project.
- `COUNCIL_PROJECT_DESC`: A brief description to give the AI context on the business logic.
- `COUNCIL_TECH_STACK`: Technologies used (helps the Docs and Performance agents).
- `COUNCIL_DOMAIN_KEYWORDS`: Comma-separated list of keywords. When these are found in the PR, the Architect agent will search for related files across the codebase.
- `COUNCIL_ARCHITECTURE_DOCS`: Comma-separated list of reference files to include in the AI's context window.
- `COUNCIL_CROSS_REPO_1` / `COUNCIL_CROSS_REPO_2`: The GitHub slug of any additional repositories the Architect agent should cross-reference when domain keywords or function signatures match.
- `COUNCIL_API_ROUTE_PREFIX`: A regex string used to identify API routes in the diff (e.g., `/api/` or `/v1/`), allowing the agent to specifically pull related architecture context.
- `COUNCIL_MAIN_MODEL`: The primary Gemini model used for code review.
- `COUNCIL_FALLBACK_MODEL`: The fallback model used if the main one rate limits or fails.
- `COUNCIL_REVIEW_COOLDOWN_MINUTES`: Cooldown period before triggering another review on the same PR (helps prevent infinite loops on automated commits).

### Github Secrets

1. Add `GEMINI_API_KEY` to your repository's actions secrets (Settings > Secrets and variables > Actions).
2. The workflow will use the default `GITHUB_TOKEN` for reading your code and posting the PR comments. Ensure your Action permissions (Settings > Actions > General) allow **Read and write permissions**.

### Cross-Repository Context (Advanced)

If your architecture spans multiple repositories (e.g., a frontend repo and a separate infrastructure repo), the **Architect Agent** can check out and cross-reference them.

1. Set a Personal Access Token (PAT) with repository access as `REPO_ACCESS_TOKEN` in your secrets.
2. Define the repositories in your workflow environment variables (`COUNCIL_CROSS_REPO_1`).
3. Whenever a developer introduces a new API route, uses one of the `COUNCIL_DOMAIN_KEYWORDS`, or modifies a function/class signature (e.g., `class MyService`), the Architect agent will intelligently scan the cross-repositories for those specific keywords to ensure contracts and architectural boundaries aren't broken.

## Prompt Customization

You can completely customize how each agent behaves by editing the Markdown prompts in the `.github/prompts/` directory.

- The system uses variables like `{{PROJECT_NAME}}` and `{{TECH_STACK}}` to dynamically inject the context you defined in the workflow file.
- If you add a new `.md` file in the prompts directory (e.g., `REVIEW_DATABASE.md`), you can add a new agent simply by updating the Orchestrator's decision logic in `ORCHESTRATOR.md` to return `"database"` in its `reviews` array.

## Privacy & Security

- **Stateless Execution:** The agents run entirely within your GitHub Actions runners.
- **Zero Data Retention:** No code is stored centrally. The system uses a hidden HTML comment within the PR itself (`<!-- council-data:xxx -->`) to persist issue tracking between commits.
- **Circuit Breakers:** The API calls use exponential backoff and circuit breaking to prevent runaway costs or infinite loops on API failures.

## Known Issues

- **Persistent vs New Issue Categorization:** The logic that differentiates between previously known issues and newly surfaced issues is currently imperfect. Due to minor code shifts or LLM output variance, the Aggregator occasionally surfaces "Persistent Issues" (issues from prior commits on unchanged files) as "New Issues." We are iterating on the fingerprinting algorithm to improve idempotency.

## License

MIT License