use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

use crate::services::flow_client::FlowClient;

pub async fn run_ws_server(flow_client: FlowClient) {
    let addr: SocketAddr = "127.0.0.1:9223".parse().unwrap();
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            println!("[Flowboard WS] WebSocket server listening on ws://{}", addr);
            l
        }
        Err(e) => {
            eprintln!("[Flowboard WS] Failed to bind WebSocket server: {}", e);
            return;
        }
    };

    while let Ok((stream, peer_addr)) = listener.accept().await {
        let flow_client_clone = flow_client.clone();
        tokio::spawn(async move {
            println!("[Flowboard WS] Extension connected from {}", peer_addr);

            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[Flowboard WS] WebSocket handshake failed: {}", e);
                    return;
                }
            };

            let (mut ws_sink, mut ws_stream) = ws_stream.split();
            let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

            // Register sender with client
            flow_client_clone.set_ws_sender(tx);

            // Send callback secret immediately
            let welcome = json!({
                "type": "callback_secret",
                "secret": flow_client_clone.callback_secret
            });
            let welcome_str = serde_json::to_string(&welcome).unwrap();
            let _ = ws_sink.send(Message::Text(welcome_str.into())).await;

            // Task 1: Forward outbound channel messages to WebSocket
            let mut write_task = tokio::spawn(async move {
                while let Some(msg) = rx.recv().await {
                    if let Err(e) = ws_sink.send(msg).await {
                        println!("[Flowboard WS] Failed to write to WebSocket: {}", e);
                        break;
                    }
                }
            });

            // Task 2: Read inbound WebSocket messages
            let flow_client_inner = flow_client_clone.clone();
            let mut read_task = tokio::spawn(async move {
                while let Some(Ok(msg)) = ws_stream.next().await {
                    match msg {
                        Message::Text(text) => {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                flow_client_inner.handle_inbound_ws_message(val);
                            }
                        }
                        Message::Close(_) => {
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Wait for either read or write to end
            tokio::select! {
                _ = &mut write_task => {}
                _ = &mut read_task => {}
            }

            // Cleanup
            write_task.abort();
            read_task.abort();
            flow_client_clone.clear_ws_sender();
            println!("[Flowboard WS] Extension disconnected");
        });
    }
}
