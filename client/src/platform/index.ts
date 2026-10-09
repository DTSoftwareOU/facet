import { createDesktopPlatform } from './desktop';
import type { Platform } from './platform';
import { createWebPlatform } from './web';

declare const __FACET_VERSION__: string;

export type * from './platform';

let current: Platform | null = null;

/** The platform this build runs on (the website or the Windows app). */
export function platform(): Platform {
  if (!current) {
    const desktop = typeof window !== 'undefined' ? window.facetDesktop : undefined;
    const version = typeof __FACET_VERSION__ === 'string' ? __FACET_VERSION__ : '1.0.0';
    // Only the Windows app's preload defines facetDesktop, so its presence decides.
    current = desktop ? createDesktopPlatform(desktop) : createWebPlatform(version);
  }
  return current;
}

/** Tests and previews can install their own platform. */
export function setPlatform(p: Platform): void {
  current = p;
}
