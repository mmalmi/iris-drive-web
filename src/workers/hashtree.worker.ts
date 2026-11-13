/**
 * Hashtree Worker Entry Point
 *
 * This file is the entry point for Vite to bundle the hashtree worker.
 */

console.log('[hashtree.worker] Loading worker module...');

// Must come first: it makes the worker send each block to a file server once.
import './installUploadOnce';
// Before the library's message handler: follow lists are caught up when asked.
import './installGraphSyncOnDemand';
// Import shared worker module from @hashtree/worker package
import '@hashtree/worker/relay-entry';

console.log('[hashtree.worker] Worker module loaded');
