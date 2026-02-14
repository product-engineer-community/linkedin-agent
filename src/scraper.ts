import { type BrowserContext, type Page, type Response } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { launchBrowser, ensureLoggedIn } from "./browser";

export interface ScraperOptions {
  output?: string;
  maxScrolls?: number;
  profile?: string;
  limit?: number;
}

export interface LinkedInPost {
  id: string;
  text: string;
  publishedAt: string;
  numLikes: number;
  numComments: number;
  numShares: number;
  url: string;
}

function extractPosts(data: any): LinkedInPost[] {
  const posts: LinkedInPost[] = [];

  try {
    const included = data?.included;
    if (!Array.isArray(included)) return posts;

    // Step 1: Build a map of activity URN -> social counts
    const countsMap = new Map<string, { numLikes: number; numComments: number; numShares: number }>();
    for (const item of included) {
      if (item?.$type === "com.linkedin.voyager.dash.feed.SocialActivityCounts" && item?.urn) {
        countsMap.set(item.urn, {
          numLikes: item.numLikes || 0,
          numComments: item.numComments || 0,
          numShares: item.numShares || 0,
        });
      }
    }

    // Step 2: Find post items with commentary
    for (const item of included) {
      const commentary = item?.commentary?.text?.text;
      if (!commentary) continue;

      // Extract activity URN from preDashEntityUrn or entityUrn
      const dashUrn = item?.preDashEntityUrn || item?.entityUrn || "";
      const activityMatch = dashUrn.match(/activity:(\d+)/);
      if (!activityMatch) continue;

      const activityId = activityMatch[1];
      const activityUrn = `urn:li:activity:${activityId}`;

      // Match with social counts
      const counts = countsMap.get(activityUrn) || { numLikes: 0, numComments: 0, numShares: 0 };

      // Extract published time from actor subDescription
      const publishedAt = item?.actor?.subDescription?.text || "";

      posts.push({
        id: activityUrn,
        text: commentary,
        publishedAt,
        numLikes: counts.numLikes,
        numComments: counts.numComments,
        numShares: counts.numShares,
        url: `https://www.linkedin.com/feed/update/${activityUrn}/`,
      });
    }
  } catch (e) {
    // silently skip malformed data
  }

  return posts;
}


function extractUsernameFromUrl(profileUrl: string): string {
  const match = profileUrl.match(/linkedin\.com\/in\/([^/?]+)/);
  if (!match) {
    throw new Error(`Invalid LinkedIn profile URL: ${profileUrl}`);
  }
  return match[1].replace(/\/$/, "");
}

async function getProfileUsername(page: Page): Promise<string> {
  // Extract username from feed page by finding profile link
  // The feed page has a profile card in the sidebar with a link to /in/{username}
  const feedUrl = page.url();

  // If we're already on the feed, try extracting from the page
  if (!feedUrl.includes("/feed")) {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
  }

  // Try multiple selectors for the profile link
  const username = await page.evaluate(() => {
    // Method 1: Look for profile link in nav/sidebar
    const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/in\/([^/?]+)/);
      if (match) return match[1];
    }
    return null;
  });

  if (username) return username;

  // Method 2: Intercept Voyager API for miniProfile
  const response = await page.goto("https://www.linkedin.com/me/", { waitUntil: "commit" });
  // Wait for redirect with longer timeout, but don't fail if it doesn't redirect
  try {
    await page.waitForURL(/linkedin\.com\/in\/[^/]+/, { timeout: 15_000 });
    const match = page.url().match(/linkedin\.com\/in\/([^/]+)/);
    if (match) return match[1];
  } catch {
    // Fallback: check current URL
    const match = page.url().match(/linkedin\.com\/in\/([^/]+)/);
    if (match) return match[1];
  }

  throw new Error("Could not detect profile username. Please provide a profile URL with --profile.");
}

async function autoScroll(page: Page, maxScrolls: number = 100, shouldStop?: () => boolean): Promise<void> {
  let previousHeight = 0;
  let noChangeCount = 0;

  for (let i = 0; i < maxScrolls; i++) {
    if (shouldStop?.()) {
      console.log(`Reached post limit. (${i} scrolls)`);
      return;
    }

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      noChangeCount++;
      if (noChangeCount >= 3) {
        console.log(`No more posts to load. (${i} scrolls)`);
        return;
      }
    } else {
      noChangeCount = 0;
    }

    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    if (i % 5 === 0) {
      console.log(`  ↓ Scrolling... (${i}/${maxScrolls})`);
    }
  }

  console.log(`Reached max scrolls (${maxScrolls}).`);
}

export async function getLinkedInPosts(options: ScraperOptions = {}): Promise<LinkedInPost[]> {
  const outputDir = options.output || process.cwd();
  const maxScrolls = options.maxScrolls || 100;

  fs.mkdirSync(outputDir, { recursive: true });

  console.log("🚀 Starting LinkedIn post scraper...\n");

  const context: BrowserContext = await launchBrowser();

  try {
    const page = context.pages()[0] || await context.newPage();
    await ensureLoggedIn(page);

    // Get profile username
    const username = options.profile
      ? extractUsernameFromUrl(options.profile)
      : await getProfileUsername(page);
    console.log(`👤 Profile: ${username}\n`);

    // Collect posts via network interception
    const allPosts = new Map<string, LinkedInPost>();

    page.on("response", async (response: Response) => {
      const url = response.url();

      if (url.includes("/voyager/api")) {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("json")) {
          try {
            const json = await response.json();
            const posts = extractPosts(json);

            for (const post of posts) {
              if (post.id && post.text && !allPosts.has(post.id)) {
                allPosts.set(post.id, post);
                console.log(`  📝 Found post #${allPosts.size}: "${post.text.substring(0, 50)}..."`);
              }
            }
          } catch {
            // Not JSON or parse error - skip
          }
        }
      }
    });

    // Navigate to activity page
    const activityUrl = `https://www.linkedin.com/in/${username}/recent-activity/all/`;
    console.log(`📂 Navigating to: ${activityUrl}\n`);
    await page.goto(activityUrl);
    await page.waitForLoadState("domcontentloaded");

    // Scroll to load all posts
    const postLimit = options.limit;
    console.log("📜 Loading posts...\n");
    await autoScroll(page, maxScrolls, postLimit ? () => allPosts.size >= postLimit : undefined);

    // Wait a bit for any remaining responses
    await page.waitForTimeout(3000);

    // Save results (merge with existing data)
    const newPosts = postLimit
      ? Array.from(allPosts.values()).slice(0, postLimit)
      : Array.from(allPosts.values());
    const outputPath = path.join(outputDir, `posts_${username}_${new Date().toISOString().split("T")[0]}.json`);

    let merged = newPosts;
    let existingCount = 0;
    if (fs.existsSync(outputPath)) {
      try {
        const existing: LinkedInPost[] = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        existingCount = existing.length;
        const mergedMap = new Map<string, LinkedInPost>();
        for (const p of existing) mergedMap.set(p.id, p);
        for (const p of newPosts) mergedMap.set(p.id, p);
        merged = Array.from(mergedMap.values());
      } catch {
        // If existing file is corrupted, overwrite with new data
      }
    }

    fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2), "utf-8");

    const newCount = merged.length - existingCount;
    if (existingCount > 0) {
      console.log(`\n✅ Done! Merged ${newPosts.length} posts with ${existingCount} existing. Total: ${merged.length} (${newCount > 0 ? `+${newCount} new` : "no new"}).`);
    } else {
      console.log(`\n✅ Done! Collected ${merged.length} posts.`);
    }
    console.log(`📁 Saved to: ${outputPath}\n`);

    const posts = merged;

    // Print summary
    const totalLikes = posts.reduce((sum, p) => sum + p.numLikes, 0);
    const totalComments = posts.reduce((sum, p) => sum + p.numComments, 0);
    console.log(`📊 Summary:`);
    console.log(`   Posts: ${posts.length}`);
    console.log(`   Likes: ${totalLikes}`);
    console.log(`   Comments: ${totalComments}`);

    return posts;
  } finally {
    await context.close();
  }
}
