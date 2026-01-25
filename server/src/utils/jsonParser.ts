/**
 * Extract and parse JSON (array or object) from LLM response text
 * Handles markdown code blocks, extra whitespace, and nested structures
 */
export function parseJsonResponse<T>(text: string): T {
	// Try to extract JSON from response (might have markdown code blocks or extra whitespace)
	let jsonText = text.trim();
	
	// Remove markdown code blocks if present
	jsonText = jsonText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
	
	// Try to find JSON array or object
	const arrayMatch = text.match(/\[[\s\S]*\]/);
	const objectMatch = text.match(/\{[\s\S]*\}/);
	
	if (arrayMatch) {
		try {
			return JSON.parse(arrayMatch[0]) as T;
		} catch (e) {
			// Fall through to try object or direct parse
		}
	}
	
	if (objectMatch) {
		try {
			return JSON.parse(objectMatch[0]) as T;
		} catch (e) {
			// Fall through to direct parse
		}
	}
	
	// Try direct parse
	try {
		return JSON.parse(jsonText) as T;
	} catch (parseError) {
		console.error('Could not extract valid JSON from response. Attempted to parse:', jsonText.substring(0, 500));
		throw new Error(`Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
	}
}

