import sys
import os
import asyncio

# Add sidecar/agent to python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from sidecar.agent.tools import _diagnose_command_failure, _detect_hardware_profile, execute_tool

def test_diagnose():
    print("--- Testing _diagnose_command_failure ---")
    
    # 1. Test missing module
    out1 = "ModuleNotFoundError: No module named 'some_missing_library'"
    diag1 = _diagnose_command_failure("python script.py", 1, out1, ".")
    print("Missing module output:\n", diag1)
    assert "some_missing_library" in diag1
    
    # 2. Test command not found
    out2 = "sh: 1: nonexistent_command: not found"
    diag2 = _diagnose_command_failure("nonexistent_command --help", 127, out2, ".")
    print("Command not found output:\n", diag2)
    assert "nonexistent_command" in diag2
    
    # 3. Test port already in use
    out3 = "Error: listen EADDRINUSE: address already in use :::3000"
    diag3 = _diagnose_command_failure("node server.js", 1, out3, ".")
    print("Port conflict output:\n", diag3)
    assert "3000" in diag3
    
    print("Diagnose tests PASSED!\n")

def test_hardware():
    print("--- Testing _detect_hardware_profile ---")
    profile = _detect_hardware_profile()
    print("Hardware profile detected:")
    for k, v in profile.items():
        print(f"  {k}: {v}")
    assert "has_gpu" in profile
    print("Hardware tests PASSED!\n")

async def test_async_tools():
    print("--- Testing execute_tool for detect_hardware ---")
    # Test execute_tool generator
    async for event in execute_tool("detect_hardware", {}):
        if event["type"] == "tool_result":
            print("Tool result returned:", event)
            assert event["ok"] is True
            
    print("--- Testing execute_tool for check_novelty ---")
    async for event in execute_tool("check_novelty", {
        "topic": "transformer self-attention",
        "hypotheses": "Using queries and keys to calculate attention weights"
    }):
        if event["type"] == "tool_result":
            print("Novelty tool result returned:", event["message"][:400] + "...")
            assert event["ok"] is True

    print("--- Testing execute_tool for review_paper ---")
    async for event in execute_tool("review_paper", {
        "path": "workspace/scratch/test_paper.md"
    }):
        if event["type"] == "tool_result":
            print("Review paper result returned:", event["message"])
            assert event["ok"] is True

    print("Async tool tests PASSED!\n")

if __name__ == "__main__":
    test_diagnose()
    test_hardware()
    asyncio.run(test_async_tools())
