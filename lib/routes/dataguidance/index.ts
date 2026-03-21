import { Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { config } from '@/config';
import logger from '@/utils/logger';
import puppeteer from '@/utils/puppeteer';

import { parseDate } from '@/utils/parse-date';

export const route: Route = {
    name: 'News',
    example: '/dataguidance/news',
    path: '/news',
    radar: [
        {
            source: ['www.dataguidance.com/info'],
        },
    ],
    maintainers: ['harveyqiu'],
    handler,
    url: 'https://www.dataguidance.com/info?article_type=news_post',
};

async function getAuthToken(): Promise<string | undefined> {
    const { username, password } = config.dataguidance;
    if (!username || !password) {
        return undefined;
    }

    const cachedToken = await cache.get('dataguidance:token');
    if (cachedToken) {
        return cachedToken as string;
    }

    logger.info('dataguidance: logging in to obtain Bearer token');

    const browser = await puppeteer({ stealth: true });
    const page = await browser.newPage();

    const tokenPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('dataguidance: timed out waiting for Bearer token')), 10_000);
        page.on('request', (request) => {
            if (!request.url().includes('https://www.dataguidance.com/api/v1/kb/content/')) {
                return;
            }
            const authHeader = request.headers().authorization;
            if (authHeader?.startsWith('Bearer ')) {
                clearTimeout(timer);
                logger.info('dataguidance: Bearer token captured');
                resolve(authHeader.slice('Bearer '.length));
            }
        });
    });

    try {
        await page.goto('https://www.dataguidance.com/login', { waitUntil: 'networkidle2' });
        await page.type('input[id="user_email"]', username);
        await page.type('input[id="user_password"]', password);

        // Accept cookies if the banner is present
        const cookieBtn = await page.$('button[id="onetrust-accept-btn-handler"]');
        if (cookieBtn) {
            await cookieBtn.click();
        }

        await page.click('button[type="submit"]');
        await page.waitForNavigation({ timeout: 10_000 });

        // Navigate to the news page to trigger an authenticated API request
        await page.goto('https://www.dataguidance.com/info?article_type=news_post', { waitUntil: 'networkidle2' });

        const authToken = await tokenPromise;
        if (!authToken) {
            throw new Error('dataguidance: failed to capture Bearer token after login');
        }

        await cache.set('dataguidance:token', authToken, 60 * 60); // cache for 1 hour
        return authToken;
    } catch (error) {
        logger.error(`dataguidance: login failed: ${error}`);
        throw error;
    } finally {
        await browser.close();
    }
}

async function handler() {
    const rootUrl = 'https://www.dataguidance.com';
    const url =
        'https://www.dataguidance.com/api/v1/kb/content/articles?news_types=510&news_types=511&news_types=512&news_types=513&order=DESC_publishedOn&limit=25&article_types=news_post';

    const token = await getAuthToken();
    const headers: Record<string, string> = {};
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    const response = await ofetch(url, { headers });

    const data = response.data;

    let items = data.map((item) => ({
        title: item.title.en,
        link: `${rootUrl}${item.url}`,
        url: item.url,
        pubDate: parseDate(item.publishedOn),
    }));
    const baseUrl = 'https://www.dataguidance.com/api/v1/kb/content/articles/by_path?path=';
    items = await Promise.all(
        items.map((item) =>
            cache.tryGet(item.link, async () => {
                const detailUrl = `${baseUrl}${item.url}`;

                const detailResponse = await ofetch(detailUrl, { headers });

                item.description = detailResponse.contentBody?.html.en.replaceAll('\n', '<br>');
                delete item.url;
                return item;
            })
        )
    );

    return {
        title: 'Data Guidance News',
        link: 'https://www.dataguidance.com/info?article_type=news_post',
        item: items,
    };
}
