from setuptools import setup

setup(
    name="tokensave",
    version="1.1.1",
    description="Cut your LLM bill 60-80%. Drop-in client with semantic cache, prompt compression and model routing.",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="TokenSaver",
    url="https://github.com/contentforge-press/tokensave",
    license="MIT",
    py_modules=["tokensave"],
    python_requires=">=3.9",
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries",
        "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ],
)
