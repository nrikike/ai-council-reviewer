const fs = require("fs");
const path = require("path");
const { callGeminiWithRetry, validateFilePath, loadPrompt } = require("./utils");

async function run() {
  try {
    console.log("Starting Auto-Fix...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

    // 1. Collect Reviews from JSON Artifacts
    const files = fs.readdirSync(process.cwd()).filter(f => f.startsWith("review-") && f.endsWith(".json"));
    const allIssues = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const report = JSON.parse(content);
        // Prefer 'reviews' (canonical), fall back to 'issues' (failsafe)
        const reviewData = report.reviews ?? report.issues;
        if (reviewData && Array.isArray(reviewData)) {
          allIssues.push(...reviewData);
        }
      } catch (e) {
        console.error(`Failed to read ${file}:`, e);
      }
    }

    if (allIssues.length === 0) {
      console.log("No issues to fix.");
      return;
    }

    // Filter for Fixable Severity (CRITICAL, HIGH) - Strict Mode
    const fixableIssues = allIssues.filter(i => 
      ["CRITICAL", "HIGH"].includes(i.severity?.toUpperCase())
    );

    if (fixableIssues.length === 0) {
      console.log("No CRITICAL/HIGH issues to fix (Medium/Low ignored).");
      return;
    }

    // Group by File
    const issuesByFile = {};
    for (const issue of fixableIssues) {
      // Resolve filepath from 'file' (new standard) or 'filepath' (legacy)
      const issueFilepath = issue.file || issue.filepath;
      
      if (!issueFilepath) continue;
      
      if (!issuesByFile[issueFilepath]) {
        issuesByFile[issueFilepath] = [];
      }
      issuesByFile[issueFilepath].push(issue);
    }

    // 2. Prepare Context
    const rootDir = path.join(__dirname, "../..");
    const agentsMdPath = path.join(rootDir, "AGENTS.md");
    const agentsMd = fs.existsSync(agentsMdPath) ? fs.readFileSync(agentsMdPath, "utf-8") : "";
    
    const fixPromptPath = path.join(rootDir, ".github/prompts/FIX_CHAIN_OF_DRAFT.md");
    const fixSystemPrompt = fs.existsSync(fixPromptPath) ? loadPrompt(fixPromptPath) : "";

    // 3. Fix Files
    for (const [filepath, issues] of Object.entries(issuesByFile)) {
      // Validate Path
      if (!validateFilePath(filepath, rootDir)) {
        console.error(`Invalid or unsafe file path: ${filepath}`);
        continue;
      }

      const fullPath = path.join(rootDir, filepath);
      if (!fs.existsSync(fullPath)) {
        console.log(`File not found: ${filepath}`);
        continue;
      }

      const fileContent = fs.readFileSync(fullPath, "utf-8");
      
      // Construct Prompt
      const issueListText = issues.map(i => `- Line ${i.line} [${i.severity}]: ${i.message}`).join("\n");
      const prompt = `
${fixSystemPrompt}

## AGENTS.md (RULES)
${agentsMd}

## ISSUES TO FIX
${issueListText}

## FILE CONTENT (${filepath})
${fileContent}
`;

      console.log(`Fixing ${filepath} (${issues.length} issues)...`);
      
      try {
        const responseText = await callGeminiWithRetry(apiKey, prompt, {});
        
        // Extract code block
        let fixedCode = responseText;
        
        // Robust regex to extract ONLY content inside code fences
        // Matches ```[lang] ...content... ```
        const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/;
        const match = fixedCode.match(codeBlockRegex);
        
        if (match) {
          fixedCode = match[1]; // Keep only the code inside the fence
        } else if (fixedCode.includes("```")) {
           // Fallback: Remove fences if regex failed but fences exist (unlikely)
           fixedCode = fixedCode.replace(/^```[^\n]*\n?/gm, "").replace(/```$/gm, "");
        } else {
           // No fences found - assume the whole response is code
           // (Gemini usually provides fences, but this covers the edge case)
           fixedCode = fixedCode.trim();
        }
        // Else: Assume the entire response is code (if no fences found) - risky but model usually fences.
        
        // Sanity Check: Don't write empty files
        if (fixedCode.trim().length === 0) {
          console.error(`Gemini returned empty code for ${filepath}`);
          continue;
        }

        fs.writeFileSync(fullPath, fixedCode);
        console.log(`Applied fixes to ${filepath}`);
        
      } catch (e) {
        console.error(`Failed to fix ${filepath}:`, e);
      }
    }

  } catch (error) {
    console.error("Auto-fix failed:", error);
    process.exit(1);
  }
}

run().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
