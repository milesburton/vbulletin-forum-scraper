import * as cheerio from 'cheerio';
import { config } from '../config';
import {
    initialiseDatabase,
    insertSubforum,
    insertThread,
    insertPost,
    insertFile,
    getSubforums,
    getThreadsBySubforum,
    closeDatabase
} from '../database';
import type {
    ScrapingStats,
    FetchError,
    ForumStats,
    Subforum
} from '../types/types';
import { askQuestion } from '../utils/readline';
import {
    logError,
    logWarning,
    logSuccess,
    logInfo,
    simpleLogInfo,
    printProgress,
    printForumStats,
    printTestModeConfig
} from '../utils/logging';
import * as fs from 'fs/promises'; // Import fs.promises
import * as path from 'path';

let stats: ScrapingStats = {
    subforums: 0,
    threads: 0,
    posts: 0,
    users: 0,
    pagesProcessed: 0,
    startTime: new Date(),
    binariesDownloaded: 0, // Add the new fields
    binariesFailed: 0,
};

let lastRequestTime = 0;

async function delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < config.DELAY_BETWEEN_REQUESTS) {
        await delay(config.DELAY_BETWEEN_REQUESTS - timeSinceLastRequest);
    }
    lastRequestTime = Date.now();
}

function createFetchError(type: FetchError['type'], message: string, status?: number): FetchError {
    const error = new Error(message) as FetchError;
    error.type = type;
    if (status) error.status = status;
    return error;
}

async function fetchWithRetry(url: string): Promise<string> {
    let lastError: FetchError | null = null;

    for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
        try {
            await rateLimit();
            simpleLogInfo(`Fetching: ${url} (Attempt ${attempt}/${config.MAX_RETRIES})`);
            const response = await fetch(url, { headers: config.HEADERS });

            if (!response.ok) {
                throw createFetchError('http', `HTTP error! status: ${response.status}`, response.status);
            }

            const text = await response.text();

            if (!text || text.length === 0) {
                throw createFetchError('empty', 'Empty response received');
            }

            return text;

        } catch (error) {
            lastError = error instanceof Error
                ? createFetchError('network', error.message)
                : createFetchError('network', 'Unknown error occurred');

            logError(`Attempt ${attempt} failed: ${lastError.message}`, lastError);

            if (attempt < config.MAX_RETRIES) {
                const delayTime = config.RETRY_DELAY * attempt;
                logWarning(`Waiting ${delayTime/1000} seconds before retry...`);
                await delay(delayTime);
            }
        }
    }

    throw createFetchError(
        lastError?.type || 'network',
        `All ${config.MAX_RETRIES} attempts failed. Last error: ${lastError?.message || 'Unknown error'}`
    );
}

async function getForumStats(): Promise<ForumStats> {
    const html = await fetchWithRetry(config.FORUM_URL);
    const $ = cheerio.load(html);

    const totals: ForumStats = {
        totalThreads: 0,
        totalPosts: 0,
        totalUsers: 0
    };

    try {
        totals.totalThreads = parseInt($('dt:contains("Threads") + dd').text().replace(/,/g, ''), 10);
        totals.totalPosts = parseInt($('dt:contains("Posts") + dd').text().replace(/,/g, ''), 10);
        totals.totalUsers = parseInt($('dt:contains("Members") + dd').text().replace(/,/g, ''), 10);

        printForumStats(totals);

        if (totals.totalThreads === 0 || totals.totalPosts === 0 || totals.totalUsers === 0) {
            throw new Error('Failed to parse forum statistics');
        }
        return totals;

    } catch (error) {
        logError('Error parsing forum statistics', error as Error);
        throw error;
    }
}

function updatePercentages(): void {
    if (!stats.totals) return;

    stats.percentComplete = {
        users: stats.totals.totalUsers === 0 ? 0 : Math.round((stats.users / stats.totals.totalUsers) * 100),
        threads: stats.totals.totalThreads === 0 ? 0 : Math.round((stats.threads / stats.totals.totalThreads) * 100),
        posts: stats.totals.totalPosts === 0 ? 0 : Math.round((stats.posts / stats.totals.totalPosts) * 100)
    };
}

async function scrapeSubforums(url: string = config.FORUM_URL, parentId: number | null = null): Promise<void> {
    if (config.TEST_MODE && stats.subforums >= (config.MAX_SUBFORUMS ?? Infinity)) {
        return;
    }

    const html = await fetchWithRetry(url);
    if (!html) {
        logError(`Failed to fetch forum HTML from ${url}.`);
        return;
    }
    const $ = cheerio.load(html);

    const subforumListItems = $('ol#forums > li.forumbit_nopost > ol.childforum > li.forumbit_post h2.forumtitle > a');

    simpleLogInfo(`Found ${subforumListItems.length} subforums/child forums on ${url}`);

    for (const element of subforumListItems.toArray()) {
        if (config.TEST_MODE && stats.subforums >= (config.MAX_SUBFORUMS ?? Infinity)) {
            return;
        }

        const $listItem = $(element);
        const title = $listItem.text().trim();
        let href = $listItem.attr('href');

        if (!title || !href) {
            logWarning(`Invalid forum title or href on ${url}`);
            continue;
        }

        const subforumUrl = new URL(href, url).href;

        let subforumRecord: Subforum;
        try {
            subforumRecord = await insertSubforum(title, subforumUrl, parentId);
            logSuccess(`Added subforum: ${title} with parentId ${parentId}`);
            stats.subforums++;
        } catch (error) {
            logError(`Failed to insert subforum ${title}`, error as Error);
            continue;
        }

        try {
            await scrapeSubforumThreads(subforumUrl);
            await delay(config.SUBFORUM_DELAY);
        } catch(error) {
            logError('Failed to scrape subforum threads', error as Error);
        }

        await scrapeSubforums(subforumUrl, subforumRecord.id);
    }
}

async function scrapeSubforumThreads(subforumUrl: string): Promise<void> {
    let pageUrl: string = subforumUrl;
    let pageCount = 0;

    while (pageUrl) {
        if (config.TEST_MODE && pageCount >= (config.MAX_PAGES_PER_SUBFORUM ?? Infinity)) {
            return;
        }
        try {
            const html = await fetchWithRetry(pageUrl);
            if (!html) {
                logError(`Failed to fetch subforum HTML: ${pageUrl}`);
                return;
            }
            const $ = cheerio.load(html);

            const threadRows = $("#threads > li.threadbit");

            simpleLogInfo(`Found ${threadRows.length} threads on page: ${pageUrl}`);
            stats.pagesProcessed++;
            pageCount++;

            let threadCount = 0;
            for (const threadRow of threadRows.toArray()) {
                if (config.TEST_MODE && threadCount >= (config.MAX_THREADS_PER_SUBFORUM ?? Infinity)) {
                    break;
                }
                try {
                    const $threadRow = $(threadRow);

                    const titleLink = $threadRow.find('h3.threadtitle a.title');
                    const title = titleLink.text().trim();
                    const href = titleLink.attr('href');

                    if (!title || !href) {
                        logWarning(`Skipping thread due to missing title or href on page: ${pageUrl}`);
                        continue;
                    }

                    const threadUrl = new URL(href, config.FORUM_URL).href;

                    const authorDateSpan = $threadRow.find('.threadmeta .author span.label');
                    const authorDateText = authorDateSpan.text().trim();

                    const authorMatch = authorDateText.match(/Started by\s*<a[^>]*>(.*?)<\/a>,\s*(.*)/) ||
                                     authorDateText.match(/Started by\s*([^,]*),\s*(.*)/);

                    let creator = "Unknown";
                    let createdAt = new Date().toISOString();

                    if (authorMatch) {
                        creator = authorMatch[1].trim();
                        createdAt = authorMatch[2].trim();
                    }

                    insertThread(subforumUrl, title, threadUrl, creator, createdAt);
                    logSuccess(`Added thread: ${title} (${createdAt}) by ${creator}`);
                    stats.threads++;
                    threadCount++;

                    await delay(config.DELAY_BETWEEN_REQUESTS);

                } catch (error) {
                    logError(`Failed to process thread on page ${pageUrl}`, error as Error);
                }
            }

            let nextLink = $('div[id*="-pagenav-"] .pagination a').last().attr('href');

            if (!nextLink) {
                nextLink = $('a[rel="next"]').attr('href');
            }
            pageUrl = nextLink ? new URL(nextLink, config.FORUM_URL).href : '';

            if (pageUrl) {
                await delay(config.DELAY_BETWEEN_REQUESTS);
            }
        } catch (error) {
            logError(`Failed to scrape page ${pageUrl}`, error as Error);
            break;
        }
    }
}


async function downloadFile(fileUrl: string, postId: number): Promise<void> {
    try {
        const fileResponse = await fetch(fileUrl, { headers: config.HEADERS });
        if (!fileResponse.ok) {
            logError(`Error downloading file: ${fileUrl}, Status: ${fileResponse.status}`);
            stats.binariesFailed++;
            return;
        }
        const fileArrayBuffer = await fileResponse.arrayBuffer();
        const mimeType = fileResponse.headers.get('content-type');
        const urlObj = new URL(fileUrl);
        const filename = urlObj.pathname.split('/').pop() || `unknown-${Date.now()}`;

        if (postId) {
            await insertFile(postId, filename, mimeType, fileArrayBuffer);
            stats.binariesDownloaded++;
            logSuccess(`Inserted file into database: ${filename}`);
        }


    } catch (fileError) {
        logError(`Error processing file ${fileUrl}`, fileError as Error);
        stats.binariesFailed++;
    }
}


async function scrapeThreadPosts(threadUrl: string, allUsers: Set<string>): Promise<void> {
    let pageUrl: string = threadUrl;
    let pageCount = 0;

    while (pageUrl) {
        if(config.TEST_MODE && pageCount >= (config.MAX_PAGES_PER_THREAD ?? Infinity)) {
            return;
        }
        try {
            const html = await fetchWithRetry(pageUrl);
            const $ = cheerio.load(html);
            const posts = $('li.postcontainer');

            simpleLogInfo(`Found ${posts.length} posts on page ${pageUrl}`);
            pageCount++;

            let postCount = 0;
            for (const post of posts) {
                if (config.TEST_MODE && postCount >= (config.MAX_POSTS_PER_THREAD ?? Infinity)) {
                    break;
                }
                try {
                    const $post = $(post);

                    const usernameElement = $post.find('.username strong');
                    const username = usernameElement.text().trim();
                    const userUrl = new URL($post.find('a.username').attr('href') || '', config.FORUM_URL).href;
                    const comment = $post.find('div[id^="post_message_"] blockquote.postcontent').text().trim();
                    const postedAt = $post.find('div.posthead span.postdate span.date').text().trim() || new Date().toISOString();
                    // Extract Post ID
                    const postIdMatch = $post.attr('id')?.match(/post_(\d+)/);
                    const postId = postIdMatch ? parseInt(postIdMatch[1], 10) : null;


                    if (username && comment && userUrl && postId) {
                        insertPost(threadUrl, username, comment, postedAt, userUrl);

                        const imageLinks = $post.find('.postcontent img[src]');
                        for (const img of imageLinks.toArray()) {
                            const $img = $(img);
                            const src = $img.attr('src');
                            if (src) {
                                const fileUrl = new URL(src, config.FORUM_URL).href;

                                if (config.DOWNLOAD_FILES) {
                                    await downloadFile(fileUrl, postId); // Use the new download function
                                } else {
                                    simpleLogInfo(`Would have downloaded: ${fileUrl}`);
                                }
                            }
                        }
                        allUsers.add(username);
                    } else {
                        logWarning(`Skipping post due to missing data on page ${pageUrl}`);
                    }

                    stats.posts++;
                    postCount++;
                    updatePercentages();
                    if (stats.posts % 100 === 0) printProgress(stats);

                } catch (error) {
                    logError('Failed to process post', error as Error);
                }
            }

            const nextLink = $('a[rel="next"]').attr('href');
            pageUrl = nextLink ? new URL(nextLink, config.FORUM_URL).href : '';

            if (pageUrl) {
                await delay(config.DELAY_BETWEEN_REQUESTS);
            }
        } catch (error) {
            logError('Failed to scrape posts', error as Error);
            break;
        }
    }
}

async function confirmScrape(): Promise<boolean> {
    if (config.TEST_MODE) {
        // Print test mode config before asking for confirmation
        await new Promise(resolve => setTimeout(resolve, 100));
        printTestModeConfig(config);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const answer = await askQuestion('Continue with scrape? (y/N) ');
    await new Promise(resolve => setTimeout(resolve, 100));
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

async function main() {
    const allUsers = new Set<string>();

    try {
        stats = {
            subforums: 0,
            threads: 0,
            posts: 0,
            users: 0,
            pagesProcessed: 0,
            startTime: new Date(),
            binariesDownloaded: 0, // Initialize new fields
            binariesFailed: 0,
        };

        await initialiseDatabase();
        logInfo('Getting forum statistics...');
        stats.totals = await getForumStats();

        // if (!await confirmScrape()) {
        //     logInfo('Scraping cancelled.');
        //     return;
        // }

        logInfo('Starting forum scrape...');
        await scrapeSubforums();

        const subforums = await getSubforums();
        for (const subforum of subforums) {
            const threads = await getThreadsBySubforum(subforum.url);
            for (const thread of threads) {
                await scrapeThreadPosts(thread.url, allUsers);
                await delay(config.DELAY_BETWEEN_REQUESTS);
            }
            await delay(config.SUBFORUM_DELAY);
        }

        logInfo('Final Statistics:');
        stats.users = allUsers.size;
        updatePercentages();
        printProgress(stats);

        logSuccess('Scraping completed successfully.');
    } catch (error) {
        logError('Fatal error', error as Error);
    } finally {
        closeDatabase();
    }
}

main();
