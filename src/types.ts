// Zendesk API response types

export interface ZendeskCategory {
  id: number;
  name: string;
  description: string;
  position: number;
  html_url: string;
  updated_at: string;
}

export interface ZendeskSection {
  id: number;
  category_id: number;
  name: string;
  description: string;
  position: number;
  html_url: string;
  updated_at: string;
}

export interface ZendeskArticle {
  id: number;
  section_id: number;
  title: string;
  body: string;
  html_url: string;
  position: number;
  vote_sum: number;
  vote_count: number;
  promoted: boolean;
  draft: boolean;
  label_names: string[];
  created_at: string;
  updated_at: string;
}

export interface ZendeskPaginatedResponse<T> {
  page: number;
  page_count: number;
  per_page: number;
  count: number;
  next_page: string | null;
  previous_page: string | null;
}

export interface ZendeskCategoriesResponse extends ZendeskPaginatedResponse<ZendeskCategory> {
  categories: ZendeskCategory[];
}

export interface ZendeskSectionsResponse extends ZendeskPaginatedResponse<ZendeskSection> {
  sections: ZendeskSection[];
}

export interface ZendeskArticlesResponse extends ZendeskPaginatedResponse<ZendeskArticle> {
  articles: ZendeskArticle[];
}

// D1 row types

export interface CategoryRow {
  id: number;
  name: string;
  description: string | null;
  position: number;
  html_url: string | null;
  updated_at: string | null;
}

export interface SectionRow {
  id: number;
  category_id: number;
  name: string;
  description: string | null;
  position: number;
  html_url: string | null;
  updated_at: string | null;
}

export interface ArticleRow {
  id: number;
  section_id: number;
  title: string;
  body_html: string | null;
  body_text: string | null;
  html_url: string | null;
  position: number;
  vote_sum: number;
  vote_count: number;
  promoted: number;
  draft: number;
  label_names: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// Worker env
export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  SKETCH_SYNC: DurableObjectNamespace;
  WORKER_URL: string;
  CTA_VARIANT?: string;
}

import type { FloorPlan } from './sketch/types';

export interface SessionCTAState {
  ctasShown: number
  lastCtaAt: number
  toolCallCount: number
}

export interface SketchSession {
  sketchId?: string;
  plan?: FloorPlan;
  cta?: SessionCTAState;
}
