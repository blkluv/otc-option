const { expect } = require("chai");
const { constants } = require("ethers");
const { parseEther, arrayify } = require("ethers/lib/utils");
const { deployments, ethers, network } = require("hardhat");
const { signOrder } = require("./utils");

describe("Putty", function () {
    let Weth;
    let Putty;
    let GoldToken;
    let CryptoPunks;
    let option;

    beforeEach(async () => {
        await deployments.fixture(["Tokens", "Putty", "Abis"]);

        const { deployer, secondary } = await ethers.getNamedSigners();
        Weth = await ethers.getContract("WETH9", deployer.address);
        GoldToken = await ethers.getContract("GoldToken", deployer.address);
        SilverToken = await ethers.getContract("SilverToken", deployer.address);
        CryptoPunks = await ethers.getContract("CryptoPunks", deployer.address);
        Putty = await ethers.getContract("Putty", deployer.address);

        option = {
            strike: parseEther("1"),
            duration: 60 * 60 * 24,
            premium: parseEther("0.6"),
            owner: secondary.address,
            nonce: 1,
            erc20Underlying: [
                {
                    token: GoldToken.address,
                    amount: parseEther("1"),
                },
                {
                    token: SilverToken.address,
                    amount: parseEther("1"),
                },
            ],
            erc721Underlying: [
                {
                    token: CryptoPunks.address,
                    tokenId: 2,
                },
                {
                    token: CryptoPunks.address,
                    tokenId: 3,
                },
            ],
        };

        for (signer of [deployer, secondary]) {
            // mint weth
            await Weth.connect(signer).approve(
                Putty.address,
                constants.MaxUint256
            );
            await signer.sendTransaction({
                value: parseEther("100"),
                to: Weth.address,
            });

            await GoldToken.mint(signer.address, parseEther("1000"));
            await GoldToken.connect(signer).approve(
                Putty.address,
                constants.MaxUint256
            );

            await SilverToken.mint(signer.address, parseEther("1000"));
            await SilverToken.connect(signer).approve(
                Putty.address,
                constants.MaxUint256
            );

            await CryptoPunks.mint(signer.address);
            await CryptoPunks.mint(signer.address);
            await CryptoPunks.connect(signer).setApprovalForAll(
                Putty.address,
                true
            );
        }
    });

    describe("meta (miscellaneous logic)", async function () {
        it("Should initialise", async function () {
            expect(await Putty.weth()).to.equal(Weth.address);
        });

        it("Should set baseURI", async function () {
            await Putty.setBaseURI("http://a.random.url");
            expect(await Putty.baseURI()).to.eq("http://a.random.url");
        });

        it("Should only allow admin to set baseURI", async function () {
            const { secondary } = await ethers.getNamedSigners();
            await expect(
                Putty.connect(secondary).setBaseURI("http://a.random.url")
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("fillBuyOrder", function () {
        it("Should fail on invalid signature", async function () {
            const { deployer } = await ethers.getNamedSigners();
            const { signature } = await signOrder(option, deployer, Putty);

            await expect(
                Putty.fillBuyOrder(option, signature, { value: option.strike })
            ).to.revertedWith("Invalid order signature");
        });

        it("Should transfer premium weth from buyer to seller", async function () {
            const { secondary, deployer } = await ethers.getNamedSigners();
            const { signature, orderHash, shortOrderHash } = await signOrder(
                option,
                secondary,
                Putty
            );

            await Putty.fillBuyOrder(option, signature, {
                value: option.strike,
            });

            // TODO: Fix this (weird bug with waffle)
            // expect(tx).to.changeTokenBalances(
            //     Weth,
            //     [deployer, secondary, Putty],
            //     [
            //         option.premium.sub(option.strike),
            //         option.premium.mul(-1),
            //         option.strike,
            //     ]
            // );

            // TODO: Fix this (waffle fails to do deep comparison)
            // expect(tx)
            //     .to.emit(Putty, "BuyFilled")
            //     .withArgs(
            //         Object.values(option),
            //         deployer.address,
            //         orderHash,
            //         shortOrderHash
            //     );

            expect(await Putty.balanceOf(secondary.address)).to.equal(1);
            expect(await Putty.ownerOf(arrayify(orderHash))).to.equal(
                secondary.address
            );
            expect(await Putty.ownerOf(arrayify(shortOrderHash))).to.equal(
                deployer.address
            );
        });

        it("Should not allow duplicate fills", async function () {
            const { secondary } = await ethers.getNamedSigners();
            const { signature } = await signOrder(option, secondary, Putty);

            await Putty.fillBuyOrder(option, signature, {
                value: option.strike,
            });
            await expect(
                Putty.fillBuyOrder(option, signature, { value: option.strike })
            ).to.be.revertedWith("Order has already been filled");
        });

        it("Should mark order as filled", async function () {
            const { secondary } = await ethers.getNamedSigners();
            const { signature, orderHash } = await signOrder(
                option,
                secondary,
                Putty
            );

            expect(await Putty.filledOrders(orderHash)).to.eq(false);

            await Putty.fillBuyOrder(option, signature, {
                value: option.strike,
            });

            expect(await Putty.filledOrders(orderHash)).to.eq(true);
        });
    });

    describe("fees", async function () {
        it("Should set feeRate", async function () {
            await Putty.setFeeRate(100);
            expect(await Putty.feeRate()).to.eq(100);
        });

        it("Should only allow admin to set feeRate", async function () {
            const { secondary } = await ethers.getNamedSigners();
            await expect(
                Putty.connect(secondary).setFeeRate(10)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should not set feeRate greater than 1000", async function () {
            await expect(Putty.setFeeRate(1001)).to.be.revertedWith(
                "Cannot charge greater than 100% fees"
            );
        });

        it("Should withdraw uncollected fees and reset uncollectedFees", async function () {
            const { deployer, secondary } = await ethers.getNamedSigners();
            const feeRate = await Putty.feeRate();

            const fillBuyOrderAndExercise = async (option) => {
                const { signature } = await signOrder(option, secondary, Putty);
                await Putty.fillBuyOrder(option, signature, {
                    value: option.strike,
                });

                await Putty.connect(secondary).exercise(option);
            };

            const option1 = { ...option, strike: parseEther("15") };
            const option2 = {
                ...option,
                strike: parseEther("8"),
                erc721Underlying: [],
            };

            await fillBuyOrderAndExercise(option1);
            const option1Fee = option1.strike.mul(feeRate).div("1000");
            expect(await Putty.uncollectedFees()).to.eq(option1Fee);

            await fillBuyOrderAndExercise(option2);
            const option2Fee = option2.strike.mul(feeRate).div("1000");
            expect(await Putty.uncollectedFees()).to.eq(
                option2Fee.add(option1Fee)
            );

            await expect(() =>
                Putty.withdrawFees(deployer.address)
            ).to.changeEtherBalances(
                [Putty, deployer],
                [
                    option1Fee.add(option2Fee).mul("-1"),
                    option1Fee.add(option2Fee),
                ]
            );
            expect(await Putty.uncollectedFees()).to.eq(0);

            const option3 = {
                ...option,
                strike: parseEther("2"),
                erc721Underlying: [],
            };
            await fillBuyOrderAndExercise(option3);
            const option3Fee = option3.strike.mul(feeRate).div("1000");
            expect(await Putty.uncollectedFees()).to.eq(option3Fee);
            await expect(() =>
                Putty.withdrawFees(secondary.address)
            ).to.changeEtherBalances(
                [Putty, secondary],
                [option3Fee.mul("-1"), option3Fee]
            );
            expect(await Putty.uncollectedFees()).to.eq(0);
        });

        it("Should only allow admin to withdraw fees", async function () {
            const { secondary } = await ethers.getNamedSigners();

            await expect(
                Putty.connect(secondary).withdrawFees(secondary.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("exercise", () => {
        let feeRate;

        beforeEach(async () => {
            const { secondary } = await ethers.getNamedSigners();

            const { signature } = await signOrder(option, secondary, Putty);

            await Putty.fillBuyOrder(option, signature, {
                value: option.strike,
            });

            feeRate = await Putty.feeRate();
        });

        it("Should mark order as filled", async function () {
            const { secondary } = await ethers.getNamedSigners();
            const { orderHash } = await signOrder(option, secondary, Putty);

            expect(await Putty.filledOrders(orderHash)).to.eq(true);
            await Putty.connect(secondary).exercise(option);
            expect(await Putty.filledOrders(orderHash)).to.eq(true);
        });

        it("Should transfer underlying to buyer and weth to seller", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();

            const [deployerBalanceBefore, secondaryBalanceBefore] = [
                await GoldToken.balanceOf(deployer.address),
                await GoldToken.balanceOf(secondary.address),
            ];

            const cryptoPunkOwnerBefore = await CryptoPunks.ownerOf(2);

            const fee = option.strike.mul(feeRate).div("1000");
            await expect(() =>
                Putty.connect(secondary).exercise(option)
            ).to.changeEtherBalances(
                [Putty, secondary],
                [option.strike.mul("-1").add(fee), option.strike.sub(fee)]
            );

            const [deployerBalanceAfter, secondaryBalanceAfter] = [
                await GoldToken.balanceOf(deployer.address),
                await GoldToken.balanceOf(secondary.address),
            ];

            expect([
                deployerBalanceAfter.sub(deployerBalanceBefore),
                secondaryBalanceAfter.sub(secondaryBalanceBefore),
            ]).to.eql([parseEther("1"), parseEther("-1")]);

            const cryptoPunkOwnerAfter = await CryptoPunks.ownerOf(2);

            expect(cryptoPunkOwnerBefore).to.not.equal(cryptoPunkOwnerAfter);
            expect(cryptoPunkOwnerAfter).to.equal(deployer.address);
        });

        it("Should not exercise option if owner is different to msg.sender", async () => {
            await expect(Putty.exercise(option)).to.be.revertedWith(
                "Cannot exercise option you dont own"
            );
        });

        it("Should not exercise expired option", async () => {
            const { secondary } = await ethers.getNamedSigners();

            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await expect(
                Putty.connect(secondary).exercise(option)
            ).to.be.revertedWith("Expired option");
        });

        it("Should not exercise option twice", async () => {
            const { secondary } = await ethers.getNamedSigners();

            await Putty.connect(secondary).exercise(option);

            await expect(
                Putty.connect(secondary).exercise(option)
            ).to.be.revertedWith("ERC721: owner query for nonexistent token");
        });

        it("Should not exercise option that doesn't exist", async () => {
            const { secondary } = await ethers.getNamedSigners();

            await expect(
                Putty.connect(secondary).exercise({
                    ...option,
                    nonce: 2,
                })
            ).to.reverted;
        });
    });

    describe("cancel", () => {
        it("Should update cancelled orders", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();
            const { orderHash } = await signOrder(option, deployer, Putty);

            await Putty.connect(secondary).cancel(option);

            expect(await Putty.cancelledOrders(arrayify(orderHash))).to.equal(
                true
            );
        });

        it("Should not fill a cancelled order", async () => {
            const { secondary } = await ethers.getNamedSigners();
            const { signature } = await signOrder(option, secondary, Putty);

            await Putty.connect(secondary).cancel(option);

            await expect(
                Putty.fillBuyOrder(option, signature, { value: option.strike })
            ).to.revertedWith("Order has been cancelled");
        });

        it("Should only allow the owner of an option to cancel", async () => {
            const { deployer } = await ethers.getNamedSigners();
            await expect(
                Putty.connect(deployer).cancel(option)
            ).to.be.revertedWith("You are not the owner");
        });
    });

    describe("expire", () => {
        beforeEach(async () => {
            const { secondary } = await ethers.getNamedSigners();
            const { signature } = await signOrder(option, secondary, Putty);

            await Putty.fillBuyOrder(option, signature, {
                value: option.strike,
            });
        });

        it("Should mark order as filled", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();
            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await Putty.expire(option);

            const { orderHash } = await signOrder(option, secondary, Putty);
            expect(await Putty.filledOrders(orderHash)).to.eq(true);
        });

        it("Should not fill buy order after it has expired", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();

            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await expect(() => Putty.expire(option)).to.changeEtherBalances(
                [Putty, deployer],
                [option.strike.mul("-1"), option.strike]
            );

            const { signature } = await signOrder(option, secondary, Putty);

            await expect(
                Putty.fillBuyOrder(option, signature, { value: option.strike })
            ).to.be.revertedWith("Order has already been filled");
        });

        it("Should return weth to seller on expiration", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();

            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await expect(() => Putty.expire(option)).to.changeEtherBalances(
                [Putty, deployer],
                [option.strike.mul("-1"), option.strike]
            );
        });

        it("Should not expire an option that has not been filled", async () => {
            await expect(Putty.expire({ ...option, nonce: 2 })).to.be.reverted;
        });

        it("Should only expire option if sufficient time has passed", async () => {
            await expect(Putty.expire(option)).to.be.revertedWith(
                "Option has not expired"
            );
        });

        it("Should not expire option twice", async () => {
            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await Putty.expire(option);

            await expect(Putty.expire(option)).to.be.revertedWith(
                "ERC721: owner query for nonexistent token"
            );
        });

        it("Should not expire an option that has already been filled", async () => {
            const { secondary, deployer } = await ethers.getNamedSigners();
            await Putty.connect(secondary).exercise(option);
            await network.provider.send("evm_increaseTime", [option.duration]);
            await network.provider.send("evm_mine");

            await expect(Putty.expire(option)).to.be.revertedWith(
                "ERC721: owner query for nonexistent token"
            );
        });
    });
});
