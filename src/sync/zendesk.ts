import type {
  ZendeskCategoriesResponse,
  ZendeskSectionsResponse,
  ZendeskArticlesResponse,
  ZendeskCategory,
  ZendeskSection,
  ZendeskArticle,
} from '../types';

const BASE_URL = 'https://help.roomsketcher.com/api/v2/help_center/en-us';

async function fetchAllPages<T>(
  initialUrl: string,
  extractItems: (data: unknown) => T[],
): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = initialUrl;

  while (url) {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Zendesk API error: ${response.status} ${response.statusText} for ${url}`);
    }
    const data = await response.json();
    items.push(...extractItems(data));
    url = (data as { next_page: string | null }).next_page;
  }

  return items;
}

export async function fetchCategories(): Promise<ZendeskCategory[]> {
  return fetchAllPages<ZendeskCategory>(
    `${BASE_URL}/categories`,
    (data) => (data as ZendeskCategoriesResponse).categories,
  );
}

export async function fetchSections(): Promise<ZendeskSection[]> {
  return fetchAllPages<ZendeskSection>(
    `${BASE_URL}/sections`,
    (data) => (data as ZendeskSectionsResponse).sections,
  );
}

export async function fetchArticles(): Promise<ZendeskArticle[]> {
  return fetchAllPages<ZendeskArticle>(
    `${BASE_URL}/articles`,
    (data) => (data as ZendeskArticlesResponse).articles,
  );
}
