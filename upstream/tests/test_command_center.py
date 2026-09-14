import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'dashboard'), str(ROOT / 'scripts')]


def test_classifier_separates_questions_small_and_formal_work():
    from command_center import build_plan, classify_instruction

    assert classify_instruction('中书省目前进展如何') == 'chat'
    assert classify_instruction('检查当前项目的测试') == 'small'
    assert classify_instruction('开发一个网页并完成测试和部署') in {'standard', 'complex'}
    assert build_plan('把代码、文档、测试和发布全部做完', 'complex')['suggestedAgents'][0] == 'taizi'
    assert build_plan('开发一个网页并完成测试', 'standard')['targetDept'] == '兵部'


def test_command_center_persists_messages_and_pending_plan(tmp_path):
    from command_center import CommandCenterStore, make_message

    store = CommandCenterStore(tmp_path)
    store.append(make_message('emperor', '测试指令'))
    store.set_pending({'id': 'pending', 'text': '复杂任务', 'plan': {'mode': 'complex'}})
    snapshot = store.snapshot()
    assert snapshot['messages'][0]['role'] == 'emperor'
    assert snapshot['pendingPlan']['id'] == 'pending'
    assert json.loads((tmp_path / 'command_center.json').read_text())['version'] == 1


@pytest.fixture
def isolated_server(tmp_path, monkeypatch):
    import server

    project = tmp_path / 'project'
    project.mkdir()
    data = tmp_path / 'data'
    data.mkdir()
    (data / 'tasks_source.json').write_text('[]')
    monkeypatch.setattr(server, 'DATA', data)
    monkeypatch.setattr(server, '_ACTIVE_TASK_DATA_DIR', data)
    monkeypatch.setattr(server, '_trigger_refresh', lambda: None)
    monkeypatch.setattr(server, 'dispatch_for_state', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, '_get_agent_session_status', lambda _agent: (0, 0, False))
    monkeypatch.setenv('EDICT_DESKTOP', '1')
    monkeypatch.setenv('EDICT_PROJECT_DIR', str(project))
    return server, data, project


def test_formal_task_lock_allows_only_one_formal_task(isolated_server):
    server, data, _project = isolated_server
    first = server.handle_command_center_message({'text': '开发一个简单网页', 'mode': 'standard', 'permissionMode': 'full'})
    second = server.handle_command_center_message({'text': '再开发另一个网页', 'mode': 'standard', 'permissionMode': 'full'})
    assert first['ok'] is True
    assert first['taskId'].startswith('JJC-')
    assert second['ok'] is False
    assert second['code'] == 'formal_task_active'
    tasks = json.loads((data / 'tasks_source.json').read_text())
    assert len([task for task in tasks if task['id'].startswith('JJC-')]) == 1
    assert tasks[0]['targetDept'] == '兵部'
    assert tasks[0]['targetAgent'] == 'taizi'


def test_small_task_uses_fixed_ministry_without_creating_formal_task(isolated_server):
    server, data, project = isolated_server
    result = server.handle_command_center_message({'text': '检查当前项目的测试', 'mode': 'small', 'permissionMode': 'full'})
    assert result['ok'] is True
    assert result['taskId'].startswith('SM-')
    task = json.loads((data / 'tasks_source.json').read_text())[0]
    assert task['workflowMode'] == 'small'
    assert task['targetAgent'] == 'bingbu'
    assert task['targetDept'] == '兵部'
    assert task['projectPath'] == str(project)
    assert pathlib.Path(task['outputDir']).is_dir()


def test_complex_task_can_wait_for_confirmation(isolated_server):
    server, _data, _project = isolated_server
    result = server.handle_command_center_message({
        'text': '规划并实现一个完整项目，同时生成代码、文档和测试',
        'mode': 'complex',
        'permissionMode': 'ask',
    })
    assert result['ok'] is True
    assert result['requiresApproval'] is True
    assert result['pendingPlan']['plan']['mode'] == 'complex'


def test_missing_execution_fields_resolve_to_a_fixed_ministry_agent(isolated_server):
    server, _data, _project = isolated_server
    department, agent_id = server._resolve_execution_assignment({
        'title': '生成一份数据统计报表',
        'state': 'Doing',
        'org': '六部',
    })
    assert department == '户部'
    assert agent_id == 'hubu'


def test_workspace_detects_project_test_commands(tmp_path):
    from execution_workspace import detect_test_commands

    project = tmp_path / 'project'
    project.mkdir()
    (project / 'package.json').write_text(json.dumps({'scripts': {'test': 'vitest'}}))
    (project / 'tests').mkdir()
    commands = detect_test_commands(project)
    assert [item['id'] for item in commands] == ['npm-test', 'pytest']


def test_task_workspace_never_displays_an_unresolved_six_ministry_agent(isolated_server):
    server, data, project = isolated_server
    task = {
        'id': 'JJC-20260415-legacy',
        'title': '开发一个网页',
        'state': 'Blocked',
        'org': '六部',
        'projectPath': str(project),
        'flow_log': [],
    }
    (data / 'tasks_source.json').write_text(json.dumps([task], ensure_ascii=False))

    result = server.get_task_workspace(task['id'])

    assert result['ok'] is True
    assert result['task']['targetDept'] == '兵部'
    assert result['task']['targetAgent'] == 'bingbu'


def test_approval_failure_preserves_plan_until_success(isolated_server):
    server, data, _ = isolated_server
    first = server.handle_command_center_message({'text': '开发一个简单网页', 'mode': 'standard'})
    planned = server.handle_command_center_message({'text': '再开发一个简单网页', 'mode': 'complex', 'permissionMode': 'ask'})
    failed = server.handle_command_center_approve()
    assert failed['ok'] is False
    assert failed['pendingPlan']['id'] == planned['pendingPlan']['id']
    server.handle_task_action(first['taskId'], 'cancel', '测试')
    approved = server.handle_command_center_approve()
    assert approved['ok'] is True
    assert approved['pendingPlan'] is None
    assert server.handle_command_center_approve()['ok'] is False
    snapshot = server.get_task_workspace(approved['taskId'])
    assert snapshot['permission']['mode'] == 'ask'
    assert snapshot['task']['targetAgent'] == 'taizi'


def test_pause_after_advancing_preserves_latest_stage(isolated_server):
    server, _, _ = isolated_server
    task = server.handle_command_center_message({'text': '开发一个简单网页', 'mode': 'standard'})
    task_id = task['taskId']
    server.handle_task_action(task_id, 'stop', '第一阶段')
    server.handle_task_action(task_id, 'resume', '')
    server.modify_task(task_id, lambda item: item.update({'state': 'Menxia', 'org': '门下省'}))
    server.handle_task_action(task_id, 'stop', '审议暂停')
    assert server.get_task_workspace(task_id)['task']['targetAgent'] == 'menxia'
    server.handle_task_action(task_id, 'resume', '')
    assert next(item for item in server.load_tasks() if item['id'] == task_id)['state'] == 'Menxia'


def test_english_work_and_multiline_route_to_work():
    from command_center import classify_instruction
    assert classify_instruction('Build a snake game') == 'standard'
    assert classify_instruction('Fix the login bug') == 'standard'
    assert classify_instruction('开发网页\n测试\n生成文档') == 'complex'


def test_empty_project_has_no_executable_test_commands(tmp_path):
    from execution_workspace import detect_test_commands
    assert detect_test_commands(tmp_path) == []


def test_dismiss_plan_does_not_create_task(isolated_server):
    server, _, _ = isolated_server
    server.handle_command_center_message({'text': '开发网页', 'mode': 'complex', 'permissionMode': 'ask'})
    assert server.dismiss_command_center_plan()['pendingPlan'] is None
    assert server.load_tasks() == []


def test_question_handoff_is_successful_without_creating_formal_task(isolated_server):
    server, _, _ = isolated_server
    result = server.handle_command_center_message({'text': '请问当前进度如何？', 'mode': 'chat'})
    assert result['ok'] is True
    assert result['action'] == 'open-yushufang'
    assert server.load_tasks() == []


def test_workspace_test_streams_output_and_records_cancel(tmp_path, monkeypatch):
    import time
    import execution_workspace as workspace
    monkeypatch.setattr(workspace, 'detect_test_commands', lambda _: [{
        'id': 'fixture', 'label': 'fixture',
        'argv': [sys.executable, '-u', '-c', 'import time; print("first output", flush=True); time.sleep(20)'],
    }])
    result = workspace.start_test(tmp_path, 'fixture-task', tmp_path, 'fixture')
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            run = workspace._latest_run(tmp_path, 'fixture-task')
            if 'first output' in run['output']:
                break
            time.sleep(0.03)
        assert run['status'] == 'running'
        assert 'first output' in run['output']
        assert workspace.cancel_run(result['runId'])['ok']
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            run = workspace._latest_run(tmp_path, 'fixture-task')
            if run['status'] != 'running':
                break
            time.sleep(0.03)
        assert run['status'] == 'cancelled'
    finally:
        workspace.cancel_run(result['runId'])
