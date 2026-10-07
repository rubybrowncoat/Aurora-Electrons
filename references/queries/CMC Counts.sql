SELECT
	p.PopName
	,pi.Amount
	,*
FROM
	vw_pop as p
inner join	FCT_PopulationInstallations as pi on pi.PopID = p.PopulationID
WHERE
	pi.PlanetaryInstallationID = 39
order by
	p.PopName
	
-- colony		b4	after
-- yeaney		9	10
-- mansi		19	20
-- markham		15	16
-- zeitz		7	8