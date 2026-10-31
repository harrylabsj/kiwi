import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/package.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)


class PackageTests(unittest.TestCase):
    def test_package_can_run_from_extracted_path_with_spaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            path,digest=builder.build(Path(tmp)/'expert.zip')
            path2,digest2=builder.build(Path(tmp)/'again.zip')
            self.assertEqual(digest,digest2)
            dest=Path(tmp)/'测试安装 with spaces'
            with zipfile.ZipFile(path) as z:
                self.assertTrue(all(n.startswith('cogawaken/') for n in z.namelist()))
                self.assertFalse(any('__pycache__' in n or n.endswith('.pyc') or '/docs/' in n for n in z.namelist()))
                z.extractall(dest)
            self.assertEqual(builder.check(dest/'cogawaken'),[])
            cli=dest/'cogawaken/skills/cogawaken-practice/scripts/cogawaken.py'
            result=subprocess.run([sys.executable,str(cli),'methods'],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(len(json.loads(result.stdout)['methods']),30)

    def test_missing_resource_and_cloud_dependency_fail_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'cogawaken';shutil.copytree(builder.PACKAGE,dest)
            p=dest/'.codebuddy-plugin/plugin.json';m=json.loads(p.read_text())
            m['dependencies']={'connectors':['anything']};p.write_text(json.dumps(m))
            self.assertTrue(builder.check(dest))
            del m['dependencies'];p.write_text(json.dumps(m))
            (dest/'skills/cogawaken-practice/references/examples.md').unlink()
            self.assertTrue(builder.check(dest))


if __name__=='__main__':unittest.main()
