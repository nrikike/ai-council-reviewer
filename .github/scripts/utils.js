const { GoogleGenerativeAI } = require("@google/generative-ai");
const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Configuration
const CONFIG = {
  model: process.env.COUNCIL_MAIN_MODEL || "gemini-3.1-pro-preview",
  fallbackModel: process.env.COUNCIL_FALLBACK_MODEL || "gemini-flash-latest",
  maxRetries: 3,
  initialDelay: 2000, // 2 seconds
  maxDelay: 30000,    // 30 seconds
  circuitBreakerThreshold: 5
};

let consecutiveFailures = 0;

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call Gemini with Exponential Backoff & Circuit Breaker
 * @param {string} apiKey - Gemini API Key
 * @param {string} prompt - System/User prompt
 * @param {Object} [options] - Configuration options
 * @param {Array} [options.tools] - Array of tool definitions for Gemini Function Calling
 * @param {Object} [options.generationConfig] - Generation config (temperature, etc)
 * @param {string} [options.model] - Override model name
 */
async function callGeminiWithRetry(apiKey, prompt, options = {}) {
  if (consecutiveFailures >= CONFIG.circuitBreakerThreshold) {
    throw new Error("Circuit breaker open: Too many consecutive failures.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = options.model || CONFIG.model;
  const useFallback = CONFIG.fallbackModel && !options._noFallback && modelName !== CONFIG.fallbackModel;
  const model = genAI.getGenerativeModel({ 
    model: modelName,
    generationConfig: options.generationConfig || {},
    tools: options.tools
  });

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);

      // Check for function calls (Tool Use)
      // Note: The SDK structure for function calls depends on version.
      // We check result.response.functionCalls() or candidates[0].content.parts
      const response = result.response;
      const functionCalls = response.functionCalls ? response.functionCalls() : [];
      
      if (functionCalls && functionCalls.length > 0) {
        // Safety Check: If we are using native tools (like googleSearch), the model handles execution internally
        // and returns the grounded text directly. We shouldn't see function calls here unless:
        // 1. We are using custom tools (which we removed)
        // 2. The model hallucinated a tool call
        
        const call = functionCalls[0];
        console.warn(`Unexpected tool call: ${call.name}.`);
        // Throwing allows the caller (gemini-review.js) to handle this as a standard API failure
        throw new Error(`Gemini unexpectedly tried to call tool '${call.name}'. This agent does not support tool execution.`);
      }
      
      const responseText = result.response.text();
      
      // Success - reset failure count
      consecutiveFailures = 0;
      return responseText;

    } catch (error) {
      lastError = error;
      // Extract status if available (depending on SDK version/error shape)
      const status = error.status || error.statusCode || (error.response && error.response.status);
      
      console.warn(`Gemini API attempt ${attempt + 1} failed: ${error.message} (Status: ${status || 'unknown'})`);
      
      // Don't retry on Auth errors (401/403) or Bad Request (400)
      if (status === 400 || status === 401 || status === 403 || 
          error.message.includes("API_KEY") || 
          error.message.includes("PERMISSION_DENIED") || 
          error.message.includes("INVALID_ARGUMENT")) {
        throw error;
      }

      if (attempt < CONFIG.maxRetries) {
        const delay = Math.min(
          CONFIG.initialDelay * Math.pow(2, attempt), 
          CONFIG.maxDelay
        );
        await sleep(delay);
      }
    }
  }

  // Fallback model (e.g. rate limit or capacity on primary)
  if (useFallback) {
    const skipFallback = lastError && (
      lastError.status === 400 || lastError.status === 401 || lastError.status === 403 ||
      lastError.message.includes("API_KEY") ||
      lastError.message.includes("PERMISSION_DENIED") ||
      lastError.message.includes("INVALID_ARGUMENT")
    );
    if (!skipFallback) {
      console.warn(`Trying fallback model: ${CONFIG.fallbackModel}`);
      try {
        const fallbackResult = await callGeminiWithRetry(apiKey, prompt, {
          ...options,
          model: CONFIG.fallbackModel,
          _noFallback: true
        });
        consecutiveFailures = 0;
        return fallbackResult;
      } catch (fallbackErr) {
        console.warn(`Fallback model also failed: ${fallbackErr.message}`);
      }
    }
  }

  consecutiveFailures++;
  throw new Error(`Gemini API failed after ${CONFIG.maxRetries + 1} attempts: ${lastError.message}`);
}

/**
 * Validate File Path (Path Traversal Protection)
 * Ensures targetPath is inside rootDir and not a sensitive file.
 */
function validateFilePath(targetPath, rootDir) {
  const resolved = path.resolve(rootDir, targetPath);
  const resolvedRoot = path.resolve(rootDir);
  
  // Check 1: Containment
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }

  // Check 2: Sensitive Paths
  // Split by path separator to ensure we match full directory names, not partials
  // e.g., "my_node_modules_test" should NOT be blocked, but "node_modules/foo" SHOULD be.
  const sensitive = ['.env', '.git', '.ssh', 'node_modules', '.github'];
  
  // Normalize separators to forward slashes for splitting to handle mixed environments (Windows/POSIX)
  const normalizedRel = rel.replace(/\\/g, '/');
  const segments = normalizedRel.split('/');
  
  // Check if any segment matches a sensitive directory name
  // Security Fix: Block strict sensitive names AND common variations (prefix matching)
  if (sensitive.some(s => {
    if (segments.includes(s)) return true;
    // Block .env.local, .env.prod, etc.
    if (s === '.env' && segments.some(seg => seg.startsWith('.env'))) return true;
    // Block .git modules, .github-action, etc.
    if (s === '.git' && segments.some(seg => seg.startsWith('.git'))) return true;
    return false;
  })) {
    return false;
  }
  return true;
}

/**
 * Parse JSON from LLM Output
 * Strips Markdown code fences if present.
 */
function parseLlmJson(text) {
  try {
    let cleanText = text.trim();
    // Match ```json ... ``` or ``` ... ```
    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleanText = codeBlockMatch[1];
    }
    return JSON.parse(cleanText);
  } catch (e) {
    throw new Error(`Failed to parse LLM JSON: ${e.message}\nInput: ${text.substring(0, 100)}...`);
  }
}

/**
 * Filter Files for Review
 * Ignores: assets, lockfiles, minified code, large data
 * Note: .md files are allowed for docs agent review
 */
function shouldReviewFile(filePath) {
  const IGNORED_EXTENSIONS = [
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
    '.lock', '.map', '.min.js', '.min.css',
    '.csv', '.tsv', '.xml', 
    '.txt', '.pdf' 
  ];
  
  const IGNORED_DIRS = [
    'node_modules/', 'dist/', 'build/', '.next/', 'coverage/', 
    'public/', 'docs/', '.github/'
  ];

  // 1. Check Extension
  if (IGNORED_EXTENSIONS.some(ext => filePath.endsWith(ext))) {
    return false;
  }

  // 2. Check Directory
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, '/');
  if (IGNORED_DIRS.some(dir => normalized.includes(dir))) {
    return false;
  }

  // 3. Special Files
  if (normalized.includes('package-lock.json') || normalized.includes('yarn.lock')) {
    return false;
  }

  return true;
}

/**
 * Generate a stable fingerprint for an issue based on file, line block, and severity.
 * Ignores message text (too unstable due to LLM variance).
 * Uses 5-line blocks to handle minor code drift.
 * @param {Object} issue - Issue object with file, line, severity
 * @returns {string} 8-character hash fingerprint
 */
function generateIssueFingerprint(issue) {
  const file = issue.file || 'general';
  // Group lines into 5-line blocks to handle minor drift
  const lineBlock = issue.line ? Math.floor(issue.line / 5) * 5 : 0;
  const severity = (issue.severity || 'info').toLowerCase();
  
  const input = `${file}:${lineBlock}:${severity}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 8);
}

/**
 * Extract fingerprints from a previous Council comment.
 * Looks for HTML comment: <!-- fingerprints:abc123,def456,... -->
 * @param {string} commentBody - The comment body text
 * @returns {Set<string>} Set of fingerprint strings
 */
function extractFingerprintsFromComment(commentBody) {
  const fingerprints = new Set();
  if (!commentBody) return fingerprints;
  
  const match = commentBody.match(/<!-- fingerprints:([a-f0-9,]+) -->/);
  if (match && match[1]) {
    match[1].split(',').forEach(fp => {
      if (fp.trim()) fingerprints.add(fp.trim());
    });
  }
  return fingerprints;
}

/**
 * Categorize issues as NEW or RECURRING based on previous fingerprints.
 * @param {Array} issues - Array of issue objects
 * @param {Set<string>} previousFingerprints - Set of fingerprints from previous run
 * @returns {Object} { newIssues: [], recurringIssues: [], allFingerprints: [] }
 */
function categorizeIssues(issues, previousFingerprints) {
  const newIssues = [];
  const recurringIssues = [];
  const allFingerprints = [];
  
  for (const issue of issues) {
    const fingerprint = generateIssueFingerprint(issue);
    allFingerprints.push(fingerprint);
    
    // Add fingerprint to issue for reference
    const issueWithFp = { ...issue, fingerprint };
    
    if (previousFingerprints.has(fingerprint)) {
      recurringIssues.push(issueWithFp);
    } else {
      newIssues.push(issueWithFp);
    }
  }
  
  return { newIssues, recurringIssues, allFingerprints };
}

/**
 * Format the fingerprints as an HTML comment for embedding in the review comment.
 * @param {Array<string>} fingerprints - Array of fingerprint strings
 * @returns {string} HTML comment string
 */
function formatFingerprintFooter(fingerprints) {
  const uniqueFingerprints = [...new Set(fingerprints)];
  return `<!-- fingerprints:${uniqueFingerprints.join(',')} -->`;
}

/**
 * Format issue data and commit SHA as a hidden HTML comment for persistence.
 * @param {string} commitSHA - Current HEAD commit SHA
 * @param {Array} issues - Array of issue objects to persist
 * @returns {string} HTML comment with encoded data
 */
function formatIssueFooter(commitSHA, issues) {
  const data = {
    sha: commitSHA,
    issues: issues.map(i => ({
      fp: i.fingerprint || generateIssueFingerprint(i), // fingerprint for dedup
      f: i.file, l: i.line, s: i.severity, m: i.message, a: i.agent // compact keys
    }))
  };
  return `<!-- council-data:${Buffer.from(JSON.stringify(data)).toString('base64')} -->`;
}

/**
 * Extract persisted issue data from a previous Council comment.
 * @param {string} commentBody - The comment body text
 * @returns {Object|null} { sha, issues: [{fingerprint, file, line, severity, message, agent}] }
 */
function extractIssuesFromComment(commentBody) {
  if (!commentBody) return null;
  const match = commentBody.match(/<!-- council-data:([A-Za-z0-9+/=]+) -->/);
  if (!match) return null;
  
  try {
    const data = JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8'));
    // Expand compact keys back to full names
    return {
      sha: data.sha,
      issues: data.issues.map(i => ({
        fingerprint: i.fp, file: i.f, line: i.l, severity: i.s, message: i.m, agent: i.a
      }))
    };
  } catch { return null; }
}

/**
 * Get list of files changed between two commits.
 * @param {string} fromSHA - Starting commit SHA
 * @returns {Set<string>} Set of changed file paths (normalized to forward slashes)
 */
function getChangedFilesSince(fromSHA) {
  // Validate SHA format to prevent command injection
  if (!/^[a-f0-9]{7,40}$/i.test(fromSHA)) return new Set();
  
  try {
    const output = execSync(`git diff --name-only ${fromSHA}...HEAD`, { encoding: 'utf-8' });
    return new Set(output.split('\n').filter(f => f.trim()).map(f => f.trim().replace(/\\/g, '/')));
  } catch { return new Set(); }
}

/** Get the current HEAD commit SHA. */
function getCurrentCommitSHA() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return null; }
}

/**
 * Filter persisted issues to keep only those in unchanged files.
 * @param {Array} previousIssues - Issues from previous review
 * @param {Set<string>} changedFiles - Set of files changed since last review (normalized paths)
 * @returns {Array} Issues that should persist (file not changed)
 */
function filterPersistentIssues(previousIssues, changedFiles) {
  return previousIssues.filter(issue => {
    if (!issue.file) return false;
    return !changedFiles.has(issue.file.replace(/\\/g, '/'));
  });
}

/**
 * Extract searchable tokens from a PR diff for cross-repo relevance.
 * Used by the architect agent to find related files in backend/infrastructure repos.
 * @param {string} diff - Full PR diff text
 * @returns {string[]} Unique tokens (paths, service names, env vars, etc.)
 */
function extractSearchTokensFromDiff(diff) {
  const tokens = new Set();
  const normalized = diff.replace(/\\/g, '/');

  // API route paths: /api/internal/..., /api/webhooks/...
  const pathMatches = normalized.match(/\/api\/[a-zA-Z0-9/_-]+/g);
  if (pathMatches) pathMatches.forEach(p => tokens.add(p));

  // Common service/feature names (customizable via env var)
  const envKeywords = process.env.COUNCIL_DOMAIN_KEYWORDS;
  const keywords = envKeywords ? envKeywords.split(',').map(k => k.trim()) : [];
  keywords.forEach(kw => {
    if (normalized.toLowerCase().includes(kw)) tokens.add(kw);
  });

  // Env / config names (UPPER_SNAKE or NEXT_PUBLIC_)
  const envMatches = normalized.match(/(?:NEXT_PUBLIC_|process\.env\.)[A-Z_][A-Z0-9_]*/g);
  if (envMatches) envMatches.forEach(e => tokens.add(e));

  return Array.from(tokens).filter(t => t.length >= 3 && t.length <= 80);
}

/**
 * Find files under rootDir whose content contains any of the given tokens.
 * Respects validateFilePath and caps the number of files.
 * @param {string} rootDir - Absolute path to repo root
 * @param {string[]} tokens - Tokens to search for
 * @param {{ maxFiles: number, maxDepth: number, allowedExt: string[] }} options
 * @returns {string[]} Relative paths of matching files
 */
function findFilesContainingTokens(rootDir, tokens, options = {}) {
  const { maxFiles = 15, maxDepth = 5, allowedExt = ['.py', '.tf', '.ts', '.tsx', '.js', '.md', '.yaml', '.yml', '.json'] } = options;
  const found = [];
  if (!tokens.length || !fs.existsSync(rootDir)) return found;

  const rootDirResolved = path.resolve(rootDir);

  function walk(dir, depth) {
    if (depth <= 0 || found.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) { return; }
    for (const e of entries) {
      if (found.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      const rel = path.relative(rootDirResolved, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) {
        walk(full, depth - 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!allowedExt.includes(ext)) continue;
        if (!validateFilePath(rel, rootDirResolved)) continue;
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const lower = content.toLowerCase();
          const hasToken = tokens.some(t => lower.includes(t.toLowerCase()));
          if (hasToken) found.push(rel);
        } catch (_err) { /* skip unreadable */ }
      }
    }
  }
  walk(rootDirResolved, maxDepth);
  return found;
}

/**
 * Load and inject environment variables into a prompt template.
 */
function loadPrompt(filePath) {
  let content = fs.readFileSync(filePath, "utf-8");
  
  // Replace placeholders with environment variables or fallback values
  const replacements = {
    '{{PROJECT_NAME}}': process.env.COUNCIL_PROJECT_NAME || "The Project",
    '{{PROJECT_DESC}}': process.env.COUNCIL_PROJECT_DESC || "A software application.",
    '{{TECH_STACK}}': process.env.COUNCIL_TECH_STACK || "Standard web technologies.",
    '{{ARCHITECTURE_DOCS}}': process.env.COUNCIL_ARCHITECTURE_DOCS || "README.md",
  };

  for (const [key, value] of Object.entries(replacements)) {
    // Replace all occurrences of the key
    content = content.split(key).join(value);
  }

  return content;
}

module.exports = {
  CONFIG,
  callGeminiWithRetry,
  validateFilePath,
  shouldReviewFile,
  parseLlmJson,
  generateIssueFingerprint,
  extractFingerprintsFromComment,
  categorizeIssues,
  formatFingerprintFooter,
  formatIssueFooter,
  extractIssuesFromComment,
  getChangedFilesSince,
  getCurrentCommitSHA,
  filterPersistentIssues,
  extractSearchTokensFromDiff,
  findFilesContainingTokens,
  loadPrompt
};

