import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

/**
 * Plays a junction's WebRTC stream through its WHEP endpoint (the protocol MediaMTX serves).
 * WebRTC runs inside the WebView, so no extra native module is needed. While connecting, or if
 * the stream fails, `fallback` (the latest JPEG frame from the live socket) is shown instead.
 */
export function LiveVideo({
  whepUrl,
  iceServers,
  fallback,
  onStatus,
}: {
  whepUrl: string;
  iceServers: unknown[];
  fallback: React.ReactNode;
  onStatus?: (status: 'connecting' | 'live' | 'failed') => void;
}) {
  const [status, setStatus] = useState<'connecting' | 'live' | 'failed'>('connecting');
  const html = useMemo(() => playerHtml(whepUrl, iceServers), [whepUrl, iceServers]);
  const update = (next: 'connecting' | 'live' | 'failed') => {
    setStatus(next);
    onStatus?.(next);
  };
  return (
    <View style={styles.frame}>
      {status !== 'failed' ? (
        <WebView
          allowsInlineMediaPlayback
          javaScriptEnabled
          mediaPlaybackRequiresUserAction={false}
          onError={() => update('failed')}
          onMessage={(event) => {
            const message = event.nativeEvent.data;
            if (message === 'live' || message === 'failed' || message === 'connecting') update(message);
          }}
          originWhitelist={['*']}
          scrollEnabled={false}
          source={{ html, baseUrl: originOf(whepUrl) }}
          style={[styles.web, status !== 'live' && styles.hidden]}
        />
      ) : null}
      {status !== 'live' ? <View style={styles.overlay}>{fallback}</View> : null}
    </View>
  );
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function playerHtml(whepUrl: string, iceServers: unknown[]) {
  const config = JSON.stringify({ whepUrl, iceServers });
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:#030712;height:100%;overflow:hidden}video{width:100%;height:100%;object-fit:contain}</style>
</head><body><video id="v" autoplay muted playsinline></video><script>
const cfg=${config};
const post=(m)=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(m);
async function start(){
  try{
    post('connecting');
    const pc=new RTCPeerConnection({iceServers:cfg.iceServers||[],bundlePolicy:'max-bundle'});
    pc.addTransceiver('video',{direction:'recvonly'});
    pc.addTransceiver('audio',{direction:'recvonly'});
    pc.ontrack=(e)=>{const v=document.getElementById('v');if(v.srcObject!==e.streams[0]){v.srcObject=e.streams[0];}};
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='connected')post('live');
      if(pc.connectionState==='failed'||pc.connectionState==='closed')post('failed');
    };
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res=await fetch(cfg.whepUrl,{method:'POST',headers:{'Content-Type':'application/sdp'},body:offer.sdp});
    if(!res.ok)throw new Error('WHEP '+res.status);
    await pc.setRemoteDescription({type:'answer',sdp:await res.text()});
    setTimeout(()=>{if(pc.connectionState!=='connected')post('failed');},15000);
  }catch(e){post('failed');}
}
start();
</script></body></html>`;
}

const styles = StyleSheet.create({
  frame: { aspectRatio: 16 / 9, backgroundColor: '#030712', borderRadius: 8, overflow: 'hidden', width: '100%' },
  web: { backgroundColor: '#030712', flex: 1 },
  hidden: { opacity: 0 },
  overlay: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
});
