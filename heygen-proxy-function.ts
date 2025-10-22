// IMPORTANT: This is an example Supabase Edge Function.
// You must deploy this function to your own Supabase project.
//
// How to deploy:
// 1. Create a Supabase project: https://supabase.com/
// 2. Install the Supabase CLI: https://supabase.com/docs/guides/cli
// 3. In your project root, run `supabase init`.
// 4. Create this file at the location: `supabase/functions/heygen-proxy/index.ts`.
// 5. You will also need a CORS helper. Create a file at `supabase/functions/_shared/cors.ts` with the content:
//    export const corsHeaders = {
//      'Access-Control-Allow-Origin': '*',
//      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
//    }
// 6. Deploy the function by running `supabase functions deploy heygen-proxy --no-verify-jwt`.
// 7. Copy the deployed function's URL and paste it into the settings panel in the main app.
//
// NOTE: For a real production app, the HeyGen API key should be set as a Supabase
// environment variable (`Deno.env.get('HEYGEN_API_KEY')`) instead of being passed
// from the client. This implementation passes it from the client for ease of use
// in this interactive development environment.

// The Deno 'serve' and 'cors' imports are assumed to be available in the Supabase environment.
// You do not need to add them to your package.json.
// import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
// import { corsHeaders } from '../_shared/cors.ts'

declare const serve: any;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HEYGEN_API_BASE_URL = 'https://api.heygen.com/v2';

// Helper function to poll for video status
const pollVideoStatus = async (videoId: string, apiKey: string): Promise<string> => {
    let status = '';
    let videoUrl = '';

    const maxAttempts = 30; // 30 attempts * 10s = 5 minutes timeout
    let attempt = 0;

    while (status !== 'succeeded' && attempt < maxAttempts) {
        attempt++;
        const response = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
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

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { imageBase64, audioUrl, apiKey } = await req.json();

        if (!imageBase64 || !audioUrl || !apiKey) {
            return new Response(JSON.stringify({ error: 'Missing imageBase64, audioUrl, or apiKey' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        // Step 1: Create Avatar from image
        const avatarResponse = await fetch(`${HEYGEN_API_BASE_URL}/avatar/from_image`, {
            method: 'POST',
            headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: imageBase64, name: `podgen-avatar-${Date.now()}` }),
        });
        if (!avatarResponse.ok) throw new Error(`HeyGen avatar creation failed: ${await avatarResponse.text()}`);
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
        if (!videoGenResponse.ok) throw new Error(`HeyGen video generation failed: ${await videoGenResponse.text()}`);
        const videoGenData = await videoGenResponse.json();
        const videoId = videoGenData.data.video_id;

        // Step 3: Poll for video status and get URL
        const finalVideoUrl = await pollVideoStatus(videoId, apiKey);

        return new Response(JSON.stringify({ videoUrl: finalVideoUrl }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error) {
        console.error('Error in Supabase function:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        });
    }
});
