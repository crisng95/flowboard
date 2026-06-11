import asyncio
import os
import json

async def main():
    try:
        from flowboard.config import _load_env_file, ROOT
        _load_env_file(ROOT / "agent" / ".env.staging")
        
        from flowboard.services.control_plane import ControlPlaneService
        cp = ControlPlaneService()
        
        # Query upload node
        res_upload = await cp.client.get("/rest/v1/nodes?id=eq.1beb465d-002b-4855-b429-3504152fd879")
        res_upload.raise_for_status()
        print("=== Upload Node ===")
        print(json.dumps(res_upload.json(), indent=2))
        
        # Query assistant node
        res_assist = await cp.client.get("/rest/v1/nodes?id=eq.6f3c1985-abae-4cae-a50d-dc8633f4b5ee")
        res_assist.raise_for_status()
        print("\n=== Assistant Node ===")
        print(json.dumps(res_assist.json(), indent=2))
            
        await cp.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    asyncio.run(main())





