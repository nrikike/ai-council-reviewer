const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { callGeminiWithRetry, parseLlmJson, loadPrompt } = require("./utils");

async function run() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is missing");
      process.exit(1);
    }

    // 1. Guardrail: Check Commit Author (Loop Prevention)
    try {
      const lastCommitAuthor = execSync("git log -1 --pretty=format:'%an'", { encoding: "utf-8" }).trim();
      const BOT_NAMES = ["Council-Bot", "ai-code-fixer", "github-actions[bot]"];
      
      if (BOT_NAMES.some(name => lastCommitAuthor.includes(name))) {
        console.log(`⏭️ Skipping review: Last commit by bot (${lastCommitAuthor})`);
        setOutput("matrix", JSON.stringify({ include: [] })); // Empty matrix skips review jobs
        return;
      }
    } catch (e) {
      console.warn("Failed to check commit author:", e.message);
    }

    // 2. Guardrail: 30-minute cooldown since last Council review comment
    const prNumber = process.env.PR_NUMBER && process.env.PR_NUMBER.trim();
    if (prNumber && /^\d+$/.test(prNumber)) {
      try {
        const commentsJson = execSync(`gh pr view ${prNumber} --json comments`, { encoding: "utf-8" });
        const { comments } = JSON.parse(commentsJson);
        const councilComments = (comments || []).filter(
          c => c.author && c.author.login === "github-actions[bot]" && c.body && c.body.includes("Council of Agents")
        );
        if (councilComments.length > 0) {
          const sorted = councilComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          const lastAt = new Date(sorted[0].createdAt);
          const now = new Date();
          const minutesAgo = (now - lastAt) / (60 * 1000);
          if (minutesAgo < 30) {
            console.log(`⏭️ Skipping review: Last Council review was ${Math.round(minutesAgo)} minutes ago (cooldown 30 min).`);
            setOutput("matrix", JSON.stringify({ include: [] }));
            return;
          }
        }
      } catch (e) {
        console.warn("Could not check Council comment cooldown:", e.message);
      }
    }

    // 3. Get PR Diff
    console.log("Fetching PR diff...");
    let diff;
    try {
      const rawBaseRef = process.env.GITHUB_BASE_REF || "main";
      const baseRef = /^[a-zA-Z0-9/._-]+$/.test(rawBaseRef) ? rawBaseRef : "main";
      
      diff = execSync(`git diff origin/${baseRef}...HEAD`, { 
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
    } catch (e) {
      console.error("Failed to get git diff:", e.message);
      process.exit(1);
    }

    if (!diff || diff.trim().length === 0) {
      console.log("No changes detected.");
      setOutput("matrix", JSON.stringify({ include: [{ agent: "general" }] }));
      return;
    }

    // Truncate diff if too large
    const MAX_CHARS = 50000;
    if (diff.length > MAX_CHARS) {
      diff = diff.substring(0, MAX_CHARS) + "\n...[Diff Truncated]...";
    }

    // Read Orchestrator Prompt
    const promptPath = path.join(__dirname, "../prompts/ORCHESTRATOR.md");
    const systemPrompt = loadPrompt(promptPath);

    const prompt = `${systemPrompt}\n\n## PR DIFF\n${diff}`;

    console.log("Analyzing PR with Gemini Orchestrator...");
    
    const responseText = await callGeminiWithRetry(apiKey, prompt, {
      generationConfig: { responseMimeType: "application/json" }
    });
    
    console.log("Orchestrator Response:", responseText);
    
    let decision;
    try {
      const parsed = parseLlmJson(responseText);
      
      // Normalize input
      if (Array.isArray(parsed)) {
        decision = { reviews: parsed };
      } else if (parsed.reviews && Array.isArray(parsed.reviews)) {
        decision = parsed;
      } else if (parsed.agents && Array.isArray(parsed.agents)) {
        decision = { reviews: parsed.agents };
      } else {
        console.warn("Unknown JSON shape, defaulting to general");
        decision = { reviews: ["general"] };
      }
    } catch (e) {
      console.error("Failed to parse JSON response:", e);
      decision = { reviews: ["general"] };
    }

    // Construct Matrix for GitHub Actions
    // Normalize each entry to ensure it's a string (handle both string and object formats)
    const matrix = {
      include: decision.reviews.map(item => {
        let agentName;
        if (typeof item === 'string') {
          agentName = item;
        } else if (item && typeof item === 'object') {
          // Extract agent name from object (e.g., { agent: "security" } or { name: "security" })
          agentName = item.agent || item.name || JSON.stringify(item);
        } else {
          agentName = String(item);
        }
        return { agent: agentName };
      })
    };

    setOutput("matrix", JSON.stringify(matrix));

  } catch (error) {
    console.error("Triage failed:", error);
    process.exit(1);
  }
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

run().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
