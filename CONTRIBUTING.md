# Contributing to AI Council Reviewer

First off, thank you for considering contributing to AI Council Reviewer! It's people like you that make open source such a great community.

## Code of Conduct

This project and everyone participating in it is governed by the [AI Council Reviewer Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

*   **Use a clear and descriptive title** for the issue to identify the problem.
*   **Describe the exact steps which reproduce the problem** in as many details as possible.
*   **Provide specific examples to demonstrate the steps**, such as the contents of your `.github/workflows/ai-code-review.yml` file (excluding secrets).
*   **Describe the behavior you observed after following the steps** and point out what exactly is the problem with that behavior.
*   **Explain which behavior you expected to see instead and why.**

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When you are creating an enhancement suggestion, please include:

*   **Use a clear and descriptive title** for the issue to identify the suggestion.
*   **Provide a step-by-step description of the suggested enhancement** in as many details as possible.
*   **Describe the current behavior** and **explain which behavior you expected to see instead** and why.
*   **Explain why this enhancement would be useful** to most AI Council Reviewer users.

### Pull Requests

The process described here has several goals:

1.  Maintain AI Council Reviewer's quality.
2.  Fix problems that are important to users.
3.  Engage the community in working toward the best possible GitHub Action.
4.  Enable a sustainable system for AI Code Reviews.

Please follow these steps to have your contribution considered by the maintainers:

1.  **Fork** the repository and create your branch from `main`.
2.  If you've added code that should be tested, add tests (or describe how you manually tested it).
3.  If you've changed APIs or configuration options, update the documentation in `README.md`.
4.  Ensure the scripts lint and execute properly.
5.  Create a pull request using the provided PR template.

## Development Setup

The core logic of this action runs on Node.js.

### Prerequisites

*   Node.js (v20+)
*   npm or yarn

### Local Testing

Currently, the best way to test changes to the Council of Agents is to:

1.  Create a test repository.
2.  Copy your modified `.github` folder into that test repository.
3.  Open a Pull Request in the test repository to trigger the workflow and observe the outputs of the Orchestrator, Specialist Matrix, and Aggregator.

Alternatively, you can run the individual scripts locally by mocking the environment variables normally provided by GitHub Actions:

```bash
export GEMINI_API_KEY="your-api-key-here"
export GITHUB_BASE_REF="main"
# ... set other required vars ...
node .github/scripts/gemini-triage.js
```

## Security

If you discover a security vulnerability within AI Council Reviewer, please do not disclose it publicly. Create a GitHub issue or contact the maintainers directly. See `SECURITY.md` (if available) for more details.

## License

By contributing to AI Council Reviewer, you agree that your contributions will be licensed under its MIT License.