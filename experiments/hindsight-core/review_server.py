"""Serve only the blind review page on loopback; never expose score/provenance files."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("page",type=Path);parser.add_argument("--port",type=int,default=8767)
    args=parser.parse_args()
    data=args.page.read_bytes()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/favicon.ico":
                self.send_response(204);self.end_headers();return
            if self.path not in {"/","/review.html"}:
                self.send_error(404);return
            self.send_response(200)
            self.send_header("Content-Type","text/html; charset=utf-8")
            self.send_header("Content-Length",str(len(data)))
            self.send_header("Cache-Control","no-store")
            self.end_headers();self.wfile.write(data)
        def log_message(self,*args):
            pass
    server=HTTPServer(("127.0.0.1",args.port),Handler)
    print("http://127.0.0.1:"+str(server.server_port)+"/review.html",flush=True)
    server.serve_forever()
