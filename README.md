# AI Council Reviewer

An advanced, multi-agent AI code review system powered by Google Gemini. This GitHub Action orchestrates a "Council" of specialized AI agents to review pull requests, providing comprehensive feedback across security, performance, architecture, documentation, and governance.

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
3. **Aggregator:** Synthesizes the individual reports into a single, cohesive, prioritized Markdown comment on the PR. It tracks "persistent" and "recurring" issues across commits.
4. **Auto-Fixer (Optional):** If requested, attempts to automatically fix critical/high severity issues and commits them directly to the branch.

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
- `COUNCIL_MAIN_MODEL`: The primary Gemini model used for code review.
- `COUNCIL_FALLBACK_MODEL`: The fallback model used if the main one rate limits or fails.
- `COUNCIL_REVIEW_COOLDOWN_MINUTES`: Cooldown period before triggering another review on the same PR (helps prevent infinite loops on automated commits).

### Github Secrets

1. Add `GEMINI_API_KEY` to your repository's actions secrets (Settings > Secrets and variables > Actions).
2. The workflow will use the default `GITHUB_TOKEN` for reading your code and posting the PR comments. Ensure your Action permissions (Settings > Actions > General) allow **Read and write permissions**.

### Cross-Repository Context (Advanced)

If your architecture spans multiple repositories (e.g., a frontend repo and a separate infrastructure repo), the **Architect Agent** can check out and cross-reference them.

1. Set a Personal Access Token (PAT) with repository access as `REPO_ACCESS_TOKEN` in your secrets.
2. Update the checkouts in the `review` job of the workflow:

```yaml
      # Cross-repo checkouts for architect.
      - name: Checkout backend repo
        if: matrix.agent == 'architect'
        uses: actions/checkout@v4
        with:
          repository: my-org/backend-service
          path: repos/backend
          token: ${{ secrets.REPO_ACCESS_TOKEN || secrets.GITHUB_TOKEN }}
          fetch-depth: 1
```

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