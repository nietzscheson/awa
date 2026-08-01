{
  description = "DevShell with Terraform, Docker, Python and ECR login";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };

        pythonEnv = pkgs.python313.withPackages (ps: with ps; [
          pip
        ]);

        commonDeps = with pkgs; [
          pythonEnv
          uv
          git
          pre-commit
          docker
          jq
          nodejs_20
          lerna
        ];
      in {
        devShells.default = pkgs.mkShell {
          packages = commonDeps;

          shellHook = ''
            pyenv global system
            export pythonEnv=${pythonEnv}
            export PATH=$PATH:${pythonEnv}/bin
            docker compose up --build -d
            docker compose ps -a
          '';
        };
      });
}