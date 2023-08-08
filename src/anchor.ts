import { assert } from 'console';

// Global constants
export const ANCHOR_LINES = 5;
const MINIMUM_MATCH_RATIO = 0.8;

// Remove newlines, tabs and spaces from anchor text
const NORMALIZE_CHARS = "\r\n\t";

function normalizeAnchor(anchor: string) {
	// Replace NORMALIZE_CHARS with empty string
	return anchor.replace(new RegExp("[" + NORMALIZE_CHARS + "]", "g"), "");
}

// Rabin fingerprint
// https://en.wikipedia.org/wiki/Rabin_fingerprint
function rabinFingerprint(anchor: string, hashSize: number) {
	let p = 53;
	let m = 2 ** 20;
	let hash = 0;
	for (let i = 0; i < hashSize; i++) {
		hash = (hash * p + anchor.charCodeAt(i)) % m;
	}
	return hash;
}

// Fast modular exponentiation
function modExp(base: number, exp: number, mod: number) {
	let result = 1;
	while (exp > 0) {
		if (exp % 2 === 1) {
			result = (result * base) % mod;
		}
		exp = Math.floor(exp / 2);
		base = (base * base) % mod;
	}
	return result;
}

// Update the rabin fingerprint of the anchor text
function updateRabinFingerprint(oldHash: number, hashSize: number, oldChar: string, newChar: string) {
	let p = 53;
	let m = 2 ** 20;
	let hash = (oldHash - oldChar.charCodeAt(0) * modExp(p, (hashSize - 1), m)) % m;
	hash = (hash * p + newChar.charCodeAt(0)) % m;
	hash = (hash + m) % m;
	return hash;
}

// Use the rabin fingerprint to find the closest matching anchor in a larger text
export function findClosestAnchor(anchor: string, text: string) {
	if (text.length < anchor.length) {
		console.log("Text is smaller than anchor");
		return -1;
	}
	else if (text.length === 0) {
		console.log("Text is empty");
		return -1;
	}
	else if (anchor.length <= 8) {
		console.log("Anchor is smaller than hash size");
		return -1;
	}

	let numLinesInAnchor = anchor.split(/\r\n|\r|\n/).length;
	anchor = normalizeAnchor(anchor);

	// Build hash set of anchor
	let hashSize = 8;
	let anchorHashes = new Set<number>();
	let currentAnchorSample = anchor.substring(0, hashSize);
	let lastHash = rabinFingerprint(currentAnchorSample, hashSize);
	let cnt = 0;
	for (let i = 0; i <= anchor.length - hashSize; i++) {
		cnt += 1;
		anchorHashes.add(lastHash);
		lastHash = updateRabinFingerprint(lastHash, hashSize, currentAnchorSample[0], anchor[(i + hashSize) % anchor.length]);
		currentAnchorSample = currentAnchorSample.substring(1) + anchor[(i + hashSize) % anchor.length];
	}
	assert(cnt === anchor.length - hashSize + 1);
	assert(anchorHashes.size <= anchor.length - hashSize + 1);

	// Build initial hash of text
	let textHashes = [];
	let start = 0;
	let currentLine = 0;
	let text2Hash = "";
	while (text2Hash.length < hashSize) {
		if (!NORMALIZE_CHARS.includes(text[start])) {
			text2Hash += text[start];
		}
		else if (text[start] === "\n") {
			currentLine++;
		}
		start++;
		if (start > text.length) {
			console.log("Could not find enough text for anchor");
			return -1;
		}
	}
	start -= hashSize;

	// Build hash set of text and find best match with anchor hash set
	lastHash = rabinFingerprint(text2Hash, hashSize);
	textHashes.push(lastHash);
	let currentTextSample = text2Hash;
	let bestMatch = -1;
	let bestMatchScore = 0;
	for (let i = start; i <= text.length - hashSize; i++) {
		// Skip over characters that we don't care about, but keep track of line numbers
		if (NORMALIZE_CHARS.includes(text[(i + hashSize) % text.length])) {
			if (text[(i + hashSize) % text.length] === "\n") {
				currentLine++;
			}
			continue;
		}
		
		// Determine how many hashes match
		let numMatches = 0;
		for (let j = 0; j < textHashes.length; j++) {
			if (anchorHashes.has(textHashes[j])) {
				numMatches++;
			}
		}
		if (numMatches >= anchorHashes.size * MINIMUM_MATCH_RATIO) {
			if (numMatches > bestMatchScore) {
				bestMatchScore = numMatches;
				bestMatch = currentLine;
			}
		}

		// Update hash sets
		lastHash = updateRabinFingerprint(lastHash, hashSize, currentTextSample[0], text[(i + hashSize) % text.length]);
		currentTextSample = currentTextSample.substring(1) + text[(i + hashSize) % text.length];
		textHashes.push(lastHash);
		if (textHashes.length > anchorHashes.size) {
			textHashes.shift();
		}
	}

	if (bestMatch === -1) {
		console.log("Could not find match in text");
		return -1;
	}
	return bestMatch - numLinesInAnchor + 1;
}
