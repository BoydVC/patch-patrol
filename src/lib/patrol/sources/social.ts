import type { Advisory, Advisory as AdvisoryType, Ecosystem, Severity, SourceId } from "../types";

export interface AdvisorySource {
  /** Stable id for logs. Use "x" when the provider reads X. */
  id: string;
  name: string;
  fetch(input: { since: Date; until: Date }): Promise<Advisory[]>;
}

/**
 * Pluggable slot for X or any other social feed.
 * Register a provider; Patch Patrol does not ship a live X client.
 */
export class SocialSourceSlot {
  private providers: AdvisorySource[] = [];

  register(provider: AdvisorySource): void {
    this.providers = this.providers.filter((item) => item.id !== provider.id).concat(provider);
  }

  list(): AdvisorySource[] {
    return [...this.providers];
  }

  async fetch(input: { since: Date; until: Date }): Promise<{
    advisories: Advisory[];
    note: string;
    empty: boolean;
  }> {
    if (this.providers.length === 0) {
      return {
        advisories: [],
        empty: true,
        note: "No social provider is registered. Implement AdvisorySource and call SocialSourceSlot.register().",
      };
    }
    const advisories: Advisory[] = [];
    const notes: string[] = [];
    for (const provider of this.providers) {
      const batch = await provider.fetch(input);
      advisories.push(
        ...batch.map((advisory) => ({
          ...advisory,
          sources: ["social"] as SourceId[],
        })),
      );
      notes.push(`${provider.name} returned ${batch.length}.`);
    }
    return { advisories, note: notes.join(" "), empty: advisories.length === 0 };
  }
}

export interface SocialPost {
  id: string;
  author?: string;
  text: string;
  publishedAt: string;
  aliases?: string[];
  severity?: Severity;
  ecosystem?: Ecosystem;
  package?: string;
  introduced?: string;
  fixed?: string;
  references?: string[];
}

export function fixtureSocialProvider(posts: SocialPost[]): AdvisorySource {
  return {
    id: "fixture-social",
    name: "Fixture social feed",
    async fetch({ since, until }) {
      return posts
        .filter((post) => {
          const time = new Date(post.publishedAt).getTime();
          return time >= since.getTime() && time <= until.getTime();
        })
        .map(postToAdvisory);
    },
  };
}

export function postToAdvisory(post: SocialPost): AdvisoryType {
  const affected =
    post.ecosystem && post.package
      ? [
          {
            ecosystem: post.ecosystem,
            name: post.package,
            ranges: [
              {
                introduced: post.introduced ?? "0",
                fixed: post.fixed,
              },
            ],
          },
        ]
      : [];
  return {
    id: post.id,
    aliases: post.aliases ?? [],
    sources: ["social"],
    summary: post.text,
    severity: post.severity ?? "unknown",
    publishedAt: post.publishedAt,
    references: post.references ?? [],
    affected,
  };
}
