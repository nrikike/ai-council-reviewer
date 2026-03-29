const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { 
  callGeminiWithRetry,
  extractFingerprintsFromComment,
  categorizeIssues,
  formatFingerprintFooter,
  formatIssueFooter,
  extractIssuesFromComment,
  getChangedFilesSince,
  getCurrentCommitSHA,
  filterPersistentIssues,
  generateIssueFingerprint,
  loadPrompt
} = require("./utils");

async function run() {
  try {
    console.log("Starting aggregation...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

    // 1. Read all review-*.json files
    const rootDir = path.join(__dirname, "../..");
    // Find JSON files in current working dir (where artifacts are downloaded)
    // Note: Actions downloads artifacts to CWD.
    const files = fs.readdirSync(process.cwd()).filter(f => f.startsWith("review-") && f.endsWith(".json"));
    const reports = [];

    for (const file of files) {
      try {
        // Normalize path just in case, though readdir returns filenames
        const content = fs.readFileSync(path.join(process.cwd(), file), "utf-8");
        reports.push(JSON.parse(content));
      } catch (e) {
        console.error(`Failed to read/parse ${file}:`, e);
      }
    }

    if (reports.length === 0) {
      console.log("No review reports found.");
      return;
    }

    // 2. Fetch Previous Comments and Extract Data
    let previousComments = "";
    let previousFingerprints = new Set();
    let previousIssueData = null; // { sha, issues }
    let previousCouncilComment = null;
    const prNumber = process.env.PR_NUMBER;
    
    if (prNumber) {
      // Security: Validate PR number before any shell command
      if (!/^\d+$/.test(prNumber)) {
        console.error("Invalid PR_NUMBER (not an integer):", prNumber);
        process.exit(1);
      }
      try {
        console.log(`Fetching previous comments for PR #${prNumber}...`);
        const commentsJson = execSync(`gh pr view ${prNumber} --json comments`, { encoding: "utf-8" });
        const commentsData = JSON.parse(commentsJson);
        
        if (Array.isArray(commentsData.comments) && commentsData.comments.length > 0) {
          // Find the previous Council comment to extract data
          previousCouncilComment = commentsData.comments.find(c => 
            c.author && c.author.login === "github-actions[bot]" && 
            c.body && c.body.includes("Council of Agents Review")
          );
          
          if (previousCouncilComment) {
            // Try new format first (full issue data)
            previousIssueData = extractIssuesFromComment(previousCouncilComment.body);
            if (previousIssueData) {
              const shaDisplay = previousIssueData.sha ? previousIssueData.sha.substring(0, 7) : 'unknown';
              console.log(`Found ${previousIssueData.issues.length} previous issues (commit: ${shaDisplay})`);
              // Build fingerprint set from previous issues for categorization
              previousIssueData.issues.forEach(i => {
                if (i.fingerprint) previousFingerprints.add(i.fingerprint);
              });
            } else {
              // Fallback to old format (fingerprints only)
              previousFingerprints = extractFingerprintsFromComment(previousCouncilComment.body);
              console.log(`Found ${previousFingerprints.size} previous fingerprints (legacy format)`);
            }
          }
        
        // Filter for relevant comments (from humans or bot) to give context
          previousComments = commentsData.comments
            .filter(c => c.author && c.author.login)
            .map(c => `**${c.author.login}**: ${c.body}`)
            .join("\n---\n");
        }
      } catch (e) {
        console.warn("Failed to fetch previous comments (non-fatal):", e.message);
      }
    }

    // 2b. Collect all issues from reports
    const allCurrentIssues = [];
    for (const report of reports) {
      const issues = report.reviews || report.issues || [];
      for (const issue of issues) {
        allCurrentIssues.push({ ...issue, agent: report.agent });
      }
    }
    
    // 2c. Determine persistent issues (from previous review, file unchanged)
    let persistentIssues = [];
    if (previousIssueData && previousIssueData.sha) {
      const changedFiles = getChangedFilesSince(previousIssueData.sha);
      console.log(`Files changed since last review: ${changedFiles.size}`);
      
      // Get fingerprints of current issues to avoid duplicates
      const currentFingerprints = new Set(
        allCurrentIssues.map(i => i.fingerprint || generateIssueFingerprint(i))
      );
      
      // Filter previous issues: keep if file unchanged AND not already in current
      const candidatePersistent = filterPersistentIssues(previousIssueData.issues, changedFiles);
      persistentIssues = candidatePersistent.filter(i => !currentFingerprints.has(i.fingerprint));
      
      console.log(`Persistent issues (not detected, file unchanged): ${persistentIssues.length}`);
    }
    
    // 2d. Categorize current issues as NEW or RECURRING
    const { newIssues, recurringIssues } = categorizeIssues(allCurrentIssues, previousFingerprints);
    console.log(`Categorized current issues: ${newIssues.length} new, ${recurringIssues.length} recurring`);

    // 3. Synthesize with Gemini (with categorized issues)
    const promptPath = path.join(rootDir, ".github/prompts/AGGREGATE.md");
    const systemPrompt = loadPrompt(promptPath);

    const prompt = `${systemPrompt}

## PREVIOUS PR COMMENTS (CONTEXT)
Use this context to understand the discussion history.
${previousComments ? previousComments : "No previous comments found."}

## CATEGORIZED ISSUES
The issues have been pre-categorized based on fingerprinting and file-level change detection:

### NEW ISSUES (${newIssues.length}) - Issues not seen in previous reviews
${JSON.stringify(newIssues, null, 2)}

### RECURRING ISSUES (${recurringIssues.length}) - Issues detected again (already reported)
${JSON.stringify(recurringIssues, null, 2)}

### PERSISTENT ISSUES (${persistentIssues.length}) - Issues from previous review, not detected this run, but file unchanged
These issues were reported before but the LLM didn't detect them this time. Since the file hasn't changed, they likely still exist.
${JSON.stringify(persistentIssues, null, 2)}

## ORIGINAL AGENT REPORTS (for reference)
${JSON.stringify(reports, null, 2)}`;

    console.log("Synthesizing reports...");
    let summary = await callGeminiWithRetry(apiKey, prompt, {});
    
    // Combine all issues for persistence (current + persistent from unchanged files)
    const allIssuesToPersist = [
      ...allCurrentIssues.map(i => ({ ...i, fingerprint: i.fingerprint || generateIssueFingerprint(i) })),
      ...persistentIssues
    ];
    
    // Append issue data footer for next run (hidden in HTML comment)
    const currentSHA = getCurrentCommitSHA();
    const issueFooter = formatIssueFooter(currentSHA, allIssuesToPersist);
    // Build fingerprint footer from same source as issueFooter for consistency
    // This ensures fallback to old format preserves persistent issues
    const allFingerprintsToPersist = allIssuesToPersist.map(i => i.fingerprint);
    const fingerprintFooter = formatFingerprintFooter(allFingerprintsToPersist);
    summary = summary.trim() + "\n\n" + fingerprintFooter + "\n" + issueFooter;

    // 4. Post to GitHub (if in PR context)
    fs.writeFileSync("review_summary.md", summary);

    const ghToken = process.env.GH_TOKEN; // Used by gh cli implicitly but good to check

    if (prNumber) {
      if (!ghToken) {
        console.warn("GH_TOKEN not set, gh cli might fail.");
      }

      console.log(`Posting/Updating comment to PR #${prNumber}...`);
      
      const tempFile = "temp_comment.md";
      fs.writeFileSync(tempFile, summary);
      
      // Check if a Council comment already exists and update it (Single Source of Truth)
      let commentUpdated = false;
      const repo = process.env.GITHUB_REPOSITORY;

      try {
        const commentsJson = execSync(`gh pr view ${prNumber} --json comments`, { encoding: "utf-8" });
        const commentsData = JSON.parse(commentsJson);
        
        // Find ANY existing Council comment (not just the last one)
        const councilComment = commentsData.comments.find(c => 
          c.author && c.author.login === "github-actions[bot]" && 
          c.body && c.body.includes("Council of Agents Review")
        );
        
        if (councilComment) {
           // 1. Check if identical (Idempotency)
           if (councilComment.body.trim() === summary.trim()) {
              console.log("Comment is identical to existing one. Skipping.");
              fs.unlinkSync(tempFile);
              return;
           }

           // 2. Update existing comment (if possible)
           // We need databaseId for REST API. 'gh pr view' JSON usually includes it.
           if (repo && councilComment.databaseId) {
             // Security: Validate repo format (owner/repo) to prevent command injection
             if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
               console.error("Invalid GITHUB_REPOSITORY format:", repo);
               process.exit(1);
             }
             // Security: Validate databaseId is a positive integer
             const commentId = Number(councilComment.databaseId);
             if (!Number.isInteger(commentId) || commentId <= 0) {
               console.error("Invalid comment databaseId:", councilComment.databaseId);
               process.exit(1);
             }
             console.log(`Updating existing comment ID: ${commentId}`);
             execSync(`gh api /repos/${repo}/issues/comments/${commentId} -X PATCH -F body=@${tempFile}`);
             console.log("Comment updated successfully.");
             commentUpdated = true;
           } else {
             console.warn("Cannot update: Missing GITHUB_REPOSITORY or databaseId. Will post new.");
           }
        }
      } catch (e) {
        console.warn("Failed to check/update existing comments:", e.message);
      }

      if (!commentUpdated) {
        try {
          execSync(`gh pr comment ${prNumber} --body-file ${tempFile}`);
          console.log("New comment posted successfully.");
        } catch (e) {
          console.error("Failed to post comment via gh:", e.message);
          console.log(summary);
        }
      }
      
      fs.unlinkSync(tempFile);
    } else {
      console.log("No PR_NUMBER provided, skipping comment post.");
      console.log("SUMMARY:\n", summary);
    }

  } catch (error) {
    console.error("Aggregation failed:", error);
    process.exit(1);
  }
}

run().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
