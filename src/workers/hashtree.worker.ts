/**
 * Hashtree Worker Entry Point
 *
 * This file is the entry point for Vite to bundle the hashtree worker.
 */

console.log('[hashtree.worker] Loading worker module...');

// Import shared worker module from @hashtree/worker package
import '@hashtree/worker/relay-entry';

console.log('[hashtree.worker] Worker module loaded');
