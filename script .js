const menu = document.querySelector(".mobilemenu")
    const nav = document.querySelector(".top")
    const undo = document.querySelector(".cancel")

    menu.addEventListener("click", function () {
        nav.style.display = "flex";
        undo.style.color = "red"
    });

    undo.addEventListener("click", function () {
        nav.style.display = "none"
        
    })