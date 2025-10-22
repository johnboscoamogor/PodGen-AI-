// This Vercel Serverless Function acts as a secure proxy to the HeyGen API.
// It should be placed in the `api` directory at the root of your project.
//
// How to use:
// 1. Place this file at `api/heygen-proxy.ts`.
// 2. Add your HeyGen API key as an environment variable in your Vercel project settings.
//    The variable name must be `HEYGEN_API_KEY`.
// 3. The frontend application will automatically call this function when you
//    select the "HeyGen (via Vercel Backend)" option.
//
// NOTE: Video generation can be a long process. This function's timeout is
// increased to 5 minutes to accommodate polling the HeyGen API. You may need a
// Vercel Pro plan for timeouts longer than 60 seconds.

// This config tells Vercel to increase the maximum duration of this function.
export const config = {
  maxDuration: 300, // 5 minutes
};

const HEYGEN_API_BASE_URL = 'https://api.heygen.com/v2';
const HEYGEN_API_V1_URL = 'https://api.heygen.com/v1';

// Helper function to poll for video status
const pollVideoStatus = async (videoId: string, apiKey: string): Promise<string> => {
    let status = '';
    let videoUrl = '';

    const maxAttempts = 30; // 30 attempts * 10s = 5 minutes timeout
    let attempt = 0;

    while (status !== 'succeeded' && attempt < maxAttempts) {
        attempt++;
        const response = await fetch(`${HEYGEN_API_V1_URL}/video_status.get?video_id=${videoId}`, {
            method: 'GET',
            headers: { 'X-Api-Key': apiKey },
        });

        if (!response.ok) {
            const errorBody = await response.json();
            throw new Error(`HeyGen status check failed: ${errorBody.message || response.statusText}`);
        }

        const data = await response.json();
        status = data.data.status;

        if (status === 'succeeded') {
            videoUrl = data.data.video_url;
            break;
        } else if (status === 'failed') {
            throw new Error(`HeyGen video generation failed: ${data.data.error?.message || 'Unknown error'}`);
        }

        // Wait for 10 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 10000));
    }

    if (status !== 'succeeded') {
        throw new Error('HeyGen video generation timed out.');
    }

    return videoUrl;
};

export default async function handler(req: Request) {
    // Handle CORS preflight request
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }

    try {
        const { imageBase64, audioUrl } = await req.json();
        const apiKey = process.env.HEYGEN_API_KEY;

        if (!apiKey) {
             return new Response(JSON.stringify({ error: 'HeyGen API key is not configured on the server. Please set the HEYGEN_API_KEY environment variable in your Vercel project.' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        }

        if (!imageBase64 || !audioUrl) {
            return new Response(JSON.stringify({ error: 'Missing imageBase64 or audioUrl' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
        }

        // Step 1: Create Avatar from image
        const avatarResponse = await fetch(`${HEYGEN_API_BASE_URL}/avatar/from_image`, {
            method: 'POST',
            headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: imageBase64, name: `podgen-avatar-${Date.now()}` }),
        });
        if (!avatarResponse.ok) {
            const errorText = await avatarResponse.text();
            throw new Error(`HeyGen avatar creation failed: ${errorText}`);
        }
        const avatarData = await avatarResponse.json();
        const avatarId = avatarData.data.avatar_id;

        // Step 2: Generate video with avatar and audio
        const videoGenResponse = await fetch(`${HEYGEN_API_BASE_URL}/video/generate`, {
            method: 'POST',
            headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_inputs: [{
                    character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
                    voice: { type: 'audio', audio_url: audioUrl }
                }],
                test: true, // Use test mode for development
                dimension: { width: 1280, height: 720 }
            }),
        });
         if (!videoGenResponse.ok) {
            const errorText = await videoGenResponse.text();
            throw new Error(`HeyGen video generation failed: ${errorText}`);
        }
        const videoGenData = await videoGenResponse.json();
        const videoId = videoGenData.data.video_id;

        // Step 3: Poll for video status and get URL
        const finalVideoUrl = await pollVideoStatus(videoId, apiKey);

        return new Response(JSON.stringify({ videoUrl: finalVideoUrl }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });

    } catch (error: any) {
        console.error('Error in Vercel function:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
}
