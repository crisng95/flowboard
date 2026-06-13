/**
 * Download a file by fetching it as a Blob first.
 * This ensures the browser respects the `download` attribute and custom filename
 * even for cross-origin URLs (e.g., assets stored on a different subdomain or cloud bucket).
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch (error) {
    console.error("Failed to download file via blob fetch, falling back to direct link", error);
    
    // Fallback: Open in a new tab if cross-origin fetch fails (e.g., due to CORS or network issues)
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
