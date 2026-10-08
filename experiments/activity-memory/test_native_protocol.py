import io
import json
import os
import unittest
from unittest.mock import patch
import core_bridge as bridge

class NativeUtilityTest(unittest.TestCase):
    def test_native_utility_uses_session_credentials_and_validates_json(self):
        for protocol in ('anthropic', 'google'):
            with self.subTest(protocol=protocol):
                envelope = ({'content':[{'type':'thinking','thinking':'PRIVATE'},{'type':'text','text':'{"atoms":[]}'}], 'stop_reason':'end_turn'}
                            if protocol == 'anthropic' else {'candidates':[{'finishReason':'STOP','content':{'parts':[{'thought':True,'text':'PRIVATE'},{'text':'{"atoms":[]}'}]}}]})
                endpoint = 'https://native.test/v1/messages' if protocol == 'anthropic' else 'https://native.test/v1beta/models/old:generateContent'
                environment = {'HCW_MODEL_PROTOCOL':protocol,'HCW_LOCAL_ENDPOINT':endpoint,'HCW_LOCAL_MODEL':'selected','HCW_LOCAL_API_KEY':'SESSION_SECRET',
                               'HCW_HINDSIGHT_UTILITY_TRACE':'','HCW_HINDSIGHT_UTILITY_ATTEMPTS':''}
                with patch.dict(os.environ, environment), patch.object(bridge, 'utility_open', return_value=io.StringIO(json.dumps(envelope))) as network:
                    self.assertEqual(bridge.utility_llm('authorized system', 'authorized evidence'), {'atoms':[]})
                    request = network.call_args.args[0]
                    body = json.loads(request.data)
                    self.assertNotIn('SESSION_SECRET', request.data.decode())
                    if protocol == 'anthropic':
                        self.assertEqual(request.get_header('X-api-key'), 'SESSION_SECRET')
                        self.assertEqual(body['messages'][0]['content'], bridge.utility_prompt('authorized evidence'))
                    else:
                        self.assertEqual(request.get_header('X-goog-api-key'), 'SESSION_SECRET')
                        self.assertIn('/models/selected:generateContent', request.full_url)
                        self.assertEqual(body['generationConfig']['responseMimeType'], 'application/json')
                    truncated = json.loads(json.dumps(envelope))
                    if protocol == 'anthropic': truncated['stop_reason'] = 'max_tokens'
                    else: truncated['candidates'][0]['finishReason'] = 'MAX_TOKENS'
                    network.return_value = io.StringIO(json.dumps(truncated))
                    with self.assertRaisesRegex(ValueError, 'output budget'):
                        bridge.utility_llm('authorized system', 'authorized evidence')
                    if protocol == 'anthropic': envelope['content'] = [{'type':'text','text':'not JSON'}]
                    else: envelope['candidates'][0]['content']['parts'] = [{'text':'not JSON'}]
                    network.return_value = io.StringIO(json.dumps(envelope))
                    with self.assertRaises(ValueError): bridge.utility_llm('authorized system', 'authorized evidence')

class NativeRedirectTest(unittest.TestCase):
    def test_native_redirect_does_not_forward_credentials(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        import urllib.request
        import urllib.error
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/sink')
                else:
                    received.append(dict(self.headers))
                    self.send_response(200)
                self.end_headers()
            def do_GET(self):
                received.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            for protocol in ('anthropic','google'):
                request=urllib.request.Request('http://127.0.0.1:' + str(server.server_port) + '/redirect', data=b'{}',headers={'x-api-key':'SESSION_SECRET'})
                with self.assertRaises(urllib.error.HTTPError): bridge.utility_open(request,protocol,timeout=2)
            self.assertEqual(received, [])
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

if __name__ == '__main__': unittest.main()
