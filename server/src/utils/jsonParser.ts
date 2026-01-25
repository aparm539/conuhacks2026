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

/**
 * Extract and parse JSON array from LLM response text
 * Handles markdown code blocks, extra whitespace, and nested arrays
 */
export function parseJsonArray<T>(text: string, expectedLength: number): T[] {
  // Try to extract JSON from response (might have markdown code blocks or extra whitespace)
  let jsonText = text.trim();
  
  // Remove markdown code blocks if present
  jsonText = jsonText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
  
  // Remove any leading/trailing non-JSON text (common with LLM responses)
  // Find the first '[' and last ']'
  const firstBracket = jsonText.indexOf('[');
  const lastBracket = jsonText.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    jsonText = jsonText.substring(firstBracket, lastBracket + 1);
  }
  
  // Try to find the outermost array by matching balanced brackets
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseError) {
    // If direct parse fails, try to extract array with balanced bracket matching
    let bracketCount = 0;
    let startIdx = -1;
    let inString = false;
    let escapeNext = false;
    
    for (let i = 0; i < jsonText.length; i++) {
      const char = jsonText[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '[') {
          if (startIdx === -1) startIdx = i;
          bracketCount++;
        } else if (char === ']') {
          bracketCount--;
          if (bracketCount === 0 && startIdx !== -1) {
            const arrayText = jsonText.substring(startIdx, i + 1);
            try {
              parsed = JSON.parse(arrayText);
              break;
            } catch (e) {
              // Continue searching
              startIdx = -1;
              bracketCount = 0;
            }
          }
        }
      }
    }
    
    if (!parsed) {
      console.error('Could not extract valid JSON array from response. Attempted to parse:', jsonText.substring(0, 500));
      throw parseError;
    }
  }
  
  // Handle nested arrays (LLM sometimes wraps responses incorrectly)
  if (Array.isArray(parsed)) {
    // If we got a nested array where the inner array has the right length, use it
    if (parsed.length === 1 && Array.isArray(parsed[0])) {
      const inner = parsed[0];
      // Check if inner array has the correct number of elements
      if (inner.length === expectedLength) {
        // Verify it has the right structure
        const isValid = inner.every(item => 
          typeof item === 'string' || Array.isArray(item)
        );
        if (isValid) {
          return inner as T[];
        }
      }
    }
    return parsed as T[];
  } else {
    throw new Error('Response is not an array');
  }
}
