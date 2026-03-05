// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');

navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('open');
    navMenu.classList.toggle('open');
});

// Close mobile menu on link click
navMenu.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('open');
        navMenu.classList.remove('open');
    });
});

// Highlight active nav link on scroll
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-link');

function highlightNav() {
    const scrollY = window.scrollY + 120;

    sections.forEach(section => {
        const top = section.offsetTop;
        const height = section.offsetHeight;
        const id = section.getAttribute('id');

        if (scrollY >= top && scrollY < top + height) {
            navLinks.forEach(link => {
                link.classList.remove('active');
                const href = link.getAttribute('href');
                if (href && href.endsWith('#' + id)) {
                    link.classList.add('active');
                }
            });
        }
    });
}

window.addEventListener('scroll', highlightNav);
highlightNav();
